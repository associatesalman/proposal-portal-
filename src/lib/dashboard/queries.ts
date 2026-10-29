import "server-only";

import type { InternalUser } from "@/lib/auth/session";
import type { createClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

import { PAGE_SIZE, toIlikePattern, type DashboardParams } from "./params";

// All queries run through the signed-in user's Supabase client, so RLS limits
// every result to what that user may see. Filters here only narrow further.

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

export type ClientListRow = Pick<
  Database["public"]["Views"]["client_list"]["Row"],
  "id" | "name" | "email" | "created_at" | "owner_id" | "owner_name" | "proposal_count"
>;

export type ProposalListRow = Pick<
  Database["public"]["Views"]["proposal_list"]["Row"],
  | "id"
  | "title"
  | "status"
  | "has_original"
  | "has_preview"
  | "created_at"
  | "client_id"
  | "client_name"
  | "owner_id"
  | "owner_name"
  | "link_created_at"
  | "deletion_requested_at"
  | "has_payments"
  | "access_mode"
  | "source_format"
  | "full_access_granted_at"
>;

export type Page<Row> = {
  rows: Row[];
  total: number;
  page: number;
  pageCount: number;
};

export type QueryResult<T> = { ok: true; data: T } | { ok: false };

export type SummaryCounts = {
  clients: number;
  proposals: number;
  drafts: number;
};

export type TeamLeadOption = { id: string; fullName: string };
export type ClientOption = { id: string; name: string; ownerName: string | null };

function logQueryError(context: string, error: { code?: string; message?: string }) {
  // Log the code/context only; never request data or credentials.
  console.error(`[dashboard] ${context} failed`, error.code ?? "unknown");
}

// Overall totals (respecting the admin owner filter), independent of search
// text and pagination.
export async function getSummaryCounts(
  supabase: ServerSupabaseClient,
  owner: string | null,
): Promise<QueryResult<SummaryCounts>> {
  const clients = supabase.from("clients").select("id", { count: "exact", head: true });
  const proposals = supabase.from("proposals").select("id", { count: "exact", head: true });
  const drafts = supabase
    .from("proposals")
    .select("id", { count: "exact", head: true })
    .eq("status", "draft");

  const [c, p, d] = await Promise.all(
    owner
      ? [clients.eq("owner_id", owner), proposals.eq("owner_id", owner), drafts.eq("owner_id", owner)]
      : [clients, proposals, drafts],
  );

  const failed = [c, p, d].find((result) => result.error);
  if (failed?.error) {
    logQueryError("summary counts", failed.error);
    return { ok: false };
  }

  return {
    ok: true,
    data: { clients: c.count ?? 0, proposals: p.count ?? 0, drafts: d.count ?? 0 },
  };
}

// Total for the current filters (used when a requested page is past the end,
// where PostgREST returns 416 without a count).
async function countMatching(
  supabase: ServerSupabaseClient,
  view: "client_list" | "proposal_list",
  params: DashboardParams,
): Promise<number | null> {
  if (view === "proposal_list") return countMatchingProposals(supabase, params);
  let query = supabase.from(view).select("id", { count: "exact", head: true });
  if (params.owner) query = query.eq("owner_id", params.owner);
  if (params.q) query = query.ilike("search_text", toIlikePattern(params.q));
  const { count, error } = await query;
  if (error) {
    logQueryError(`${view} count`, error);
    return null;
  }
  return count ?? 0;
}

async function countMatchingProposals(
  supabase: ServerSupabaseClient,
  params: DashboardParams,
): Promise<number | null> {
  let query = supabase.from("proposal_list").select("id", { count: "exact", head: true });
  if (params.owner) query = query.eq("owner_id", params.owner);
  if (params.q) query = query.ilike("search_text", toIlikePattern(params.q));
  const status = historyStatus(params);
  if (status === "deleting") query = query.not("deletion_requested_at", "is", null);
  else if (status) query = query.eq("status", status).is("deletion_requested_at", null);
  const { count, error } = await query;
  if (error) {
    logQueryError("proposal_list count", error);
    return null;
  }
  return count ?? 0;
}

function pageRange(page: number) {
  const from = (page - 1) * PAGE_SIZE;
  return { from, to: from + PAGE_SIZE - 1 };
}

export async function listClients(
  supabase: ServerSupabaseClient,
  params: DashboardParams,
): Promise<QueryResult<Page<ClientListRow>>> {
  const { from, to } = pageRange(params.page);

  let query = supabase
    .from("client_list")
    .select("id, name, email, created_at, owner_id, owner_name, proposal_count", {
      count: "exact",
    });
  if (params.owner) query = query.eq("owner_id", params.owner);
  if (params.q) query = query.ilike("search_text", toIlikePattern(params.q));

  const { data, count, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, to);

  // PostgREST answers 416 (PGRST103) for an offset past the end: an empty page.
  if (error && error.code !== "PGRST103") {
    logQueryError("client list", error);
    return { ok: false };
  }

  const total = error ? await countMatching(supabase, "client_list", params) : (count ?? 0);
  if (total === null) return { ok: false };
  return {
    ok: true,
    data: {
      rows: error ? [] : (data ?? []),
      total,
      page: params.page,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    },
  };
}

// History tab status filter (applied in the database query; RLS has already
// limited the rows). Lifecycle values exclude proposals being deleted.
function historyStatus(params: DashboardParams) {
  return params.tab === "history" && params.status !== "all" ? params.status : null;
}

// Proposals tab and Proposal History (same rows; History adds a status
// filter). Drafts and issued proposals are both included.
export async function listProposals(
  supabase: ServerSupabaseClient,
  params: DashboardParams,
): Promise<QueryResult<Page<ProposalListRow>>> {
  const { from, to } = pageRange(params.page);

  let query = supabase
    .from("proposal_list")
    .select(
      "id, title, status, has_original, has_preview, created_at, client_id, client_name, owner_id, owner_name, link_created_at, deletion_requested_at, has_payments, access_mode, source_format, full_access_granted_at",
      { count: "exact" },
    );
  if (params.owner) query = query.eq("owner_id", params.owner);
  if (params.q) query = query.ilike("search_text", toIlikePattern(params.q));
  const status = historyStatus(params);
  if (status === "deleting") query = query.not("deletion_requested_at", "is", null);
  else if (status) query = query.eq("status", status).is("deletion_requested_at", null);

  const { data, count, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, to);

  if (error && error.code !== "PGRST103") {
    logQueryError("proposal list", error);
    return { ok: false };
  }

  const total = error ? await countMatching(supabase, "proposal_list", params) : (count ?? 0);
  if (total === null) return { ok: false };
  return {
    ok: true,
    data: {
      rows: error ? [] : (data ?? []),
      total,
      page: params.page,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    },
  };
}

// Team leads an admin can assign new clients to / filter by.
export async function listTeamLeads(
  supabase: ServerSupabaseClient,
  user: InternalUser,
): Promise<QueryResult<TeamLeadOption[]>> {
  if (user.role !== "admin") return { ok: true, data: [] };

  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("role", "team_lead")
    .order("full_name");

  if (error) {
    logQueryError("team leads", error);
    return { ok: false };
  }

  return { ok: true, data: (data ?? []).map((p) => ({ id: p.id, fullName: p.full_name })) };
}

// Clients the user may create proposals for (RLS: own clients; admin: all).
export async function listClientOptions(
  supabase: ServerSupabaseClient,
): Promise<QueryResult<ClientOption[]>> {
  const { data, error } = await supabase
    .from("client_list")
    .select("id, name, owner_name")
    .order("name")
    .limit(1000);

  if (error) {
    logQueryError("client options", error);
    return { ok: false };
  }

  return {
    ok: true,
    data: (data ?? []).map((c) => ({ id: c.id, name: c.name, ownerName: c.owner_name })),
  };
}

// ---------------------------------------------------------------------------
// Payments tab
// ---------------------------------------------------------------------------

export type PaymentListRow = Pick<
  Database["public"]["Views"]["payment_list"]["Row"],
  | "id"
  | "owner_id"
  | "owner_name"
  | "client_name"
  | "proposal_title"
  | "revision_id"
  | "amount_minor"
  | "currency"
  | "status"
  | "status_detail"
  | "needs_review"
  | "review_reason"
  | "refunded_amount_minor"
  | "verified_at"
  | "provider_payment_id"
  | "provider_order_id"
  | "environment"
  | "created_at"
>;

const PAYMENT_COLUMNS =
  "id, owner_id, owner_name, client_name, proposal_title, revision_id, amount_minor, currency, status, status_detail, needs_review, review_reason, refunded_amount_minor, verified_at, provider_payment_id, provider_order_id, environment, created_at";

type PaymentStatusValue = Database["public"]["Enums"]["payment_status"];

const PAYMENT_FILTER_STATUSES: Record<Exclude<DashboardParams["paymentStatus"], "all" | "review">, PaymentStatusValue[]> = {
  completed: ["succeeded", "partially_refunded"],
  pending: ["pending"],
  awaiting: ["created"],
  refunded: ["refunded", "reversed"],
  unsuccessful: ["failed", "denied", "cancelled"],
};

function paymentStatuses(params: DashboardParams): PaymentStatusValue[] | null {
  return params.paymentStatus === "all" || params.paymentStatus === "review"
    ? null
    : PAYMENT_FILTER_STATUSES[params.paymentStatus];
}

async function countMatchingPayments(
  supabase: ServerSupabaseClient,
  params: DashboardParams,
): Promise<number | null> {
  let query = supabase.from("payment_list").select("id", { count: "exact", head: true });
  if (params.owner) query = query.eq("owner_id", params.owner);
  if (params.q) query = query.ilike("search_text", toIlikePattern(params.q));
  if (params.paymentStatus === "review") query = query.is("needs_review", true);
  const statuses = paymentStatuses(params);
  if (statuses) query = query.in("status", statuses);
  const { count, error } = await query;
  if (error) {
    logQueryError("payment_list count", error);
    return null;
  }
  return count ?? 0;
}

// Payments the user may see (RLS: a lead's own proposals, all for the
// admin), newest first, paginated in the database. Records are created only
// by the server's checkout and PayPal verification code.
export async function listPayments(
  supabase: ServerSupabaseClient,
  params: DashboardParams,
): Promise<QueryResult<Page<PaymentListRow>>> {
  const { from, to } = pageRange(params.page);

  let query = supabase.from("payment_list").select(PAYMENT_COLUMNS, { count: "exact" });
  if (params.owner) query = query.eq("owner_id", params.owner);
  if (params.q) query = query.ilike("search_text", toIlikePattern(params.q));
  if (params.paymentStatus === "review") query = query.is("needs_review", true);
  const statuses = paymentStatuses(params);
  if (statuses) query = query.in("status", statuses);

  const { data, count, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, to);

  if (error && error.code !== "PGRST103") {
    logQueryError("payment list", error);
    return { ok: false };
  }

  const total = error ? await countMatchingPayments(supabase, params) : (count ?? 0);
  if (total === null) return { ok: false };
  return {
    ok: true,
    data: {
      rows: error ? [] : (data ?? []),
      total,
      page: params.page,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    },
  };
}

export type PaymentSummary = {
  all: number;
  completed: number;
  pending: number;
  needsReview: number;
  // Completed payments net of completed refunds, per currency (never mixed).
  receivedByCurrency: { currency: string; amountMinor: number }[];
};

export async function getPaymentSummary(
  supabase: ServerSupabaseClient,
  owner: string | null,
): Promise<QueryResult<PaymentSummary>> {
  let totals = supabase.from("payment_totals").select("owner_id, currency, status, payments, amount_minor, refunded_minor");
  if (owner) totals = totals.eq("owner_id", owner);
  let review = supabase.from("payments").select("id", { count: "exact", head: true }).eq("needs_review", true);
  if (owner) review = review.eq("owner_id", owner);

  const [t, r] = await Promise.all([totals, review]);
  if (t.error || r.error) {
    logQueryError("payment summary", (t.error ?? r.error)!);
    return { ok: false };
  }

  const summary: PaymentSummary = { all: 0, completed: 0, pending: 0, needsReview: r.count ?? 0, receivedByCurrency: [] };
  const received = new Map<string, number>();
  for (const row of t.data ?? []) {
    summary.all += row.payments;
    if (row.status === "pending") summary.pending += row.payments;
    if (row.status === "succeeded" || row.status === "partially_refunded") {
      summary.completed += row.payments;
      received.set(row.currency, (received.get(row.currency) ?? 0) + Number(row.amount_minor) - Number(row.refunded_minor));
    }
  }
  summary.receivedByCurrency = [...received]
    .map(([currency, amountMinor]) => ({ currency, amountMinor }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
  return { ok: true, data: summary };
}
