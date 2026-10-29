"use server";

import { randomUUID } from "node:crypto";

import { refresh } from "next/cache";
import { z } from "zod";

import { getInternalUserOrReason, type InternalUser } from "@/lib/auth/session";
import type { FormState, FormValues } from "@/lib/dashboard/form-state";
import { limitUserAction } from "@/lib/security/internal-limits";
import { isUnavailableError } from "@/lib/supabase/fetch";
import { deleteProposalPermanently } from "@/lib/supabase/privileged";
import { createClient } from "@/lib/supabase/server";
import {
  createClientSchema,
  createProposalSchema,
  deleteProposalSchema,
  displayNameSchema,
  updateClientSchema,
  updateProposalTitleSchema,
} from "@/lib/validation/dashboard";

// Every action independently: verifies the signed-in internal user (role from
// profiles), validates input with Zod, derives ownership on the server, and
// writes through the user's RLS-scoped Supabase client. Browser-supplied
// owner_id values are never trusted. Permanent proposal deletion is the one
// exception: after the RLS check it runs the trusted workflow in
// src/lib/supabase/privileged.ts, which removes storage objects.

const SESSION_EXPIRED = "Your session has expired. Sign in again to continue.";
const SERVICE_UNAVAILABLE = "The service is temporarily unavailable. Nothing was saved. Try again in a moment.";
const GENERIC_ERROR = "Something went wrong. Try again.";
const CLIENT_NOT_FOUND = "This client could not be found, or you don't have access to it.";
const PROPOSAL_NOT_FOUND = "This proposal could not be found, or you don't have access to it.";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

function readValues(formData: FormData, fields: string[]): FormValues {
  const values: FormValues = {};
  for (const field of fields) {
    const value = formData.get(field);
    values[field] = typeof value === "string" ? value.slice(0, 1000) : "";
  }
  return values;
}

function error(
  message: string,
  values: FormValues,
  fieldErrors?: Record<string, string | undefined>,
): FormState {
  return { status: "error", message, values, fieldErrors };
}

function validationError(zodError: z.ZodError, values: FormValues): FormState {
  const { fieldErrors } = z.flattenError(zodError);
  const firstErrors: Record<string, string | undefined> = {};
  for (const [field, messages] of Object.entries(fieldErrors)) {
    firstErrors[field] = (messages as string[] | undefined)?.[0];
  }
  return error("Check the highlighted fields and try again.", values, firstErrors);
}

function success(message: string): FormState {
  refresh();
  return { status: "success", message, submissionId: randomUUID() };
}

function logActionError(context: string, err: { code?: string }) {
  console.error(`[dashboard] ${context} failed`, err.code ?? "unknown");
}

// Returns the verified user and an RLS-scoped client, or the message to show
// (signed out, or Supabase unreachable: an outage never reads as "signed out").
async function authenticate(): Promise<
  { ok: true; user: InternalUser; supabase: ServerSupabaseClient } | { ok: false; message: string }
> {
  const auth = await getInternalUserOrReason();
  if (!auth.ok) return { ok: false, message: auth.reason === "unavailable" ? SERVICE_UNAVAILABLE : SESSION_EXPIRED };
  return { ok: true, user: auth.user, supabase: await createClient() };
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export async function createClientAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const values = readValues(formData, ["name", "email", "ownerId"]);
  const auth = await authenticate();
  if (!auth.ok) return error(auth.message, values);
  const { user, supabase } = auth;

  const parsed = createClientSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, values);

  let ownerId: string;
  if (user.role === "admin") {
    if (!parsed.data.ownerId) {
      return error("Check the highlighted fields and try again.", values, {
        ownerId: "Select a team lead.",
      });
    }
    // The owner must be an existing team lead (read through admin RLS).
    const { data: lead, error: leadError } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", parsed.data.ownerId)
      .eq("role", "team_lead")
      .maybeSingle();
    if (leadError) {
      logActionError("load team lead", leadError);
      return error(GENERIC_ERROR, values);
    }
    if (!lead) {
      return error("Check the highlighted fields and try again.", values, {
        ownerId: "Select an existing team lead.",
      });
    }
    ownerId = lead.id;
  } else {
    // Team leads always own the clients they create; any submitted ownerId is ignored.
    ownerId = user.id;
  }

  const { error: insertError } = await supabase
    .from("clients")
    .insert({ owner_id: ownerId, name: parsed.data.name, email: parsed.data.email });

  if (insertError) {
    logActionError("create client", insertError);
    return error(GENERIC_ERROR, values);
  }

  return success(`Client “${parsed.data.name}” added.`);
}

export async function updateClientAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const values = readValues(formData, ["clientId", "name", "email"]);
  const auth = await authenticate();
  if (!auth.ok) return error(auth.message, values);
  const { supabase } = auth;

  const parsed = updateClientSchema.safeParse(values);
  if (!parsed.success) {
    if (z.flattenError(parsed.error).fieldErrors.clientId) {
      return error(CLIENT_NOT_FOUND, values);
    }
    return validationError(parsed.error, values);
  }

  // RLS limits the update to rows the user may manage; zero rows means the
  // client doesn't exist or belongs to someone else.
  const { data, error: updateError } = await supabase
    .from("clients")
    .update({ name: parsed.data.name, email: parsed.data.email })
    .eq("id", parsed.data.clientId)
    .select("id");

  if (updateError) {
    logActionError("update client", updateError);
    return error(GENERIC_ERROR, values);
  }
  if (!data || data.length === 0) return error(CLIENT_NOT_FOUND, values);

  return success(`Client “${parsed.data.name}” updated.`);
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export async function createProposalAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const values = readValues(formData, ["clientId", "title"]);
  const auth = await authenticate();
  if (!auth.ok) return error(auth.message, values);
  const { supabase } = auth;

  const parsed = createProposalSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, values);

  // Ownership comes from the client record, loaded through RLS: a lead can
  // only resolve their own clients, so another lead's client id is "not found".
  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, owner_id")
    .eq("id", parsed.data.clientId)
    .maybeSingle();

  if (clientError) {
    logActionError("load client", clientError);
    return error(GENERIC_ERROR, values);
  }
  if (!client) {
    return error("Check the highlighted fields and try again.", values, {
      clientId: "Select a client you have access to.",
    });
  }

  // Draft: no PDF paths, page counts, offer values or link are set here.
  const { error: insertError } = await supabase.from("proposals").insert({
    client_id: client.id,
    owner_id: client.owner_id,
    title: parsed.data.title,
  });

  if (insertError) {
    logActionError("create proposal", insertError);
    return error(GENERIC_ERROR, values);
  }

  return success(`Draft “${parsed.data.title}” created.`);
}

export async function updateProposalTitleAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const values = readValues(formData, ["proposalId", "title"]);
  const auth = await authenticate();
  if (!auth.ok) return error(auth.message, values);
  const { supabase } = auth;

  const parsed = updateProposalTitleSchema.safeParse(values);
  if (!parsed.success) {
    if (z.flattenError(parsed.error).fieldErrors.proposalId) {
      return error(PROPOSAL_NOT_FOUND, values);
    }
    return validationError(parsed.error, values);
  }

  // Only drafts are editable in this phase; enforced here, not just in the UI.
  const { data, error: updateError } = await supabase
    .from("proposals")
    .update({ title: parsed.data.title })
    .eq("id", parsed.data.proposalId)
    .eq("status", "draft")
    .is("deletion_requested_at", null)
    .select("id");

  if (updateError) {
    logActionError("update proposal title", updateError);
    return error(GENERIC_ERROR, values);
  }

  if (!data || data.length === 0) {
    const { data: existing } = await supabase
      .from("proposals")
      .select("status, deletion_requested_at")
      .eq("id", parsed.data.proposalId)
      .maybeSingle();
    if (existing?.deletion_requested_at) {
      return error("This proposal is being deleted and can no longer be changed.", values);
    }
    if (existing && existing.status !== "draft") {
      return error("Only draft proposals can be edited.", values);
    }
    return error(PROPOSAL_NOT_FOUND, values);
  }

  return success(`Draft renamed to “${parsed.data.title}”.`);
}

// ---------------------------------------------------------------------------
// Permanent proposal deletion
// ---------------------------------------------------------------------------

const PAYMENTS_RETAINED =
  "This proposal has payment records, which must be kept. It can't be deleted until an archive process is available. Nothing was changed.";
const DELETION_INCOMPLETE =
  "Deletion didn't finish: some stored files couldn't be removed yet. The proposal is hidden from clients and its link no longer works. Use “Retry deletion” to finish.";

export async function deleteProposalAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const values = readValues(formData, ["proposalId"]);
  const auth = await authenticate();
  if (!auth.ok) return error(auth.message, values);
  const { user, supabase } = auth;

  const parsed = deleteProposalSchema.safeParse(values);
  if (!parsed.success) return error(PROPOSAL_NOT_FOUND, values);

  // Loaded through RLS first: another lead's proposal, or a guessed id, is
  // "not found" and never reaches the trusted workflow (which re-checks).
  const { data: proposal, error: loadError } = await supabase
    .from("proposals")
    .select("id, title")
    .eq("id", parsed.data.proposalId)
    .maybeSingle();
  if (loadError) {
    logActionError("load proposal for deletion", loadError);
    return error(isUnavailableError(loadError) ? SERVICE_UNAVAILABLE : GENERIC_ERROR, values);
  }
  if (!proposal) return error(PROPOSAL_NOT_FOUND, values);

  const limit = await limitUserAction("proposal_delete_user", user.id, "deletion");
  if (!limit.ok) return error(limit.message, values);

  const result = await deleteProposalPermanently({ actorId: user.id, proposalId: proposal.id });
  if (!result.ok) {
    logActionError(`delete proposal (${result.stage})`, result.error);
    if (result.stage === "begin") {
      if (result.error.code === "PT404") return error(PROPOSAL_NOT_FOUND, values);
      if (result.error.code === "PT412") return error(PAYMENTS_RETAINED, values);
      return error(GENERIC_ERROR, values);
    }
    if (result.error.code === "PT412") return error(PAYMENTS_RETAINED, values);
    // Gone after this request started it: a concurrent deletion finished the
    // workflow (the row is only removed once its storage is empty).
    if (result.error.code === "PT404") {
      return success(`“${proposal.title}” was already deleted. Its client link no longer works.`);
    }
    // The proposal is marked as deleting: refresh so the list shows it.
    refresh();
    return error(DELETION_INCOMPLETE, values);
  }

  return success(`“${proposal.title}” and its PDFs were permanently deleted. Its client link no longer works.`);
}

// ---------------------------------------------------------------------------
// Own display name
// ---------------------------------------------------------------------------

export async function updateDisplayNameAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const values = readValues(formData, ["fullName"]);
  const auth = await authenticate();
  if (!auth.ok) return error(auth.message, values);
  const { user, supabase } = auth;

  const parsed = displayNameSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, values);

  // Only full_name, only the signed-in user's own row: the id comes from the
  // verified session, and the database allows nothing else (column grant +
  // own-row policy). Nothing from the form selects the row.
  const { data, error: updateError } = await supabase
    .from("profiles")
    .update({ full_name: parsed.data.fullName })
    .eq("id", user.id)
    .select("id");

  if (updateError) {
    logActionError("update display name", updateError);
    return error(isUnavailableError(updateError) ? SERVICE_UNAVAILABLE : GENERIC_ERROR, values);
  }
  if (!data || data.length === 0) return error(GENERIC_ERROR, values);

  return success(`Display name changed to “${parsed.data.fullName}”.`);
}
