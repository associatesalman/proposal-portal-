import { z } from "zod";

// Collapses runs of whitespace and trims, so "  Acme   Ltd " is stored as "Acme Ltd".
function normalizeText(value: unknown): unknown {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value;
}

const requiredText = (label: string, max: number) =>
  z.preprocess(
    normalizeText,
    z
      .string(`Enter a ${label}.`)
      .min(1, `Enter a ${label}.`)
      .max(max, `Use ${max} characters or fewer.`),
  );

const email = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z
    .string("Enter an email address.")
    .min(1, "Enter an email address.")
    .max(320, "Use 320 characters or fewer.")
    .pipe(z.email("Enter a valid email address.")),
);

const recordId = (message: string) => z.uuid(message);

export const CLIENT_NAME_MAX = 200;
export const PROPOSAL_TITLE_MAX = 300;

export const createClientSchema = z.object({
  name: requiredText("client name", CLIENT_NAME_MAX),
  email,
  // Only honoured for admins; team leads always own what they create.
  ownerId: z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    recordId("Select a team lead.").optional(),
  ),
});

export const updateClientSchema = z.object({
  clientId: recordId("This client could not be found."),
  name: requiredText("client name", CLIENT_NAME_MAX),
  email,
});

export const createProposalSchema = z.object({
  clientId: recordId("Select a client."),
  title: requiredText("proposal title", PROPOSAL_TITLE_MAX),
});

// Display names are one line of printable text. Only the signed-in user's own
// name is ever updated (see updateDisplayNameAction); role and ids are not
// part of this schema.
export const DISPLAY_NAME_MAX = 100;

export const displayNameSchema = z.object({
  fullName: requiredText("display name", DISPLAY_NAME_MAX).refine(
    (value) => typeof value === "string" && !/[\u0000-\u001f\u007f-\u009f]/.test(value),
    "Use letters, numbers and punctuation only.",
  ),
});

export const deleteProposalSchema = z.object({
  proposalId: recordId("This proposal could not be found."),
});

export const updateProposalTitleSchema = z.object({
  proposalId: recordId("This proposal could not be found."),
  title: requiredText("proposal title", PROPOSAL_TITLE_MAX),
});
