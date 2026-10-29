"use client";

import { FilePlus2, Pencil, Trash2 } from "lucide-react";

import {
  createProposalAction,
  deleteProposalAction,
  updateProposalTitleAction,
} from "@/app/(dashboard)/dashboard/actions";
import { SelectField, TextField } from "@/components/ui/fields";
import { calloutStyles } from "@/components/ui/styles";
import type { ClientOption } from "@/lib/dashboard/queries";
import { PROPOSAL_TITLE_MAX } from "@/lib/validation/dashboard";

import { ActionFormDialog, fieldError, fieldValue } from "./action-form-dialog";

export function NewProposalDialog({
  clients,
  showOwners,
}: {
  clients: ClientOption[];
  showOwners: boolean;
}) {
  return (
    <ActionFormDialog
      formId="proposal-form-create"
      title="New proposal"
      description="Creates a draft. Then use “Manage Document” to upload the document, choose its access and create the private link."
      action={createProposalAction}
      submitLabel="Create draft"
      pendingLabel="Creating…"
      trigger={{
        label: (
          <>
            <FilePlus2 aria-hidden="true" />
            <span className="max-sm:sr-only">New proposal</span>
          </>
        ),
        variant: "primary",
        disabled: clients.length === 0,
      }}
      renderFields={(state) => (
        <>
          <SelectField
            label="Client"
            name="clientId"
            required
            placeholder="Select a client…"
            options={clients.map((client) => ({
              value: client.id,
              label:
                showOwners && client.ownerName
                  ? `${client.name} — ${client.ownerName}`
                  : client.name,
            }))}
            defaultValue={fieldValue(state, "clientId")}
            error={fieldError(state, "clientId")}
          />
          <TextField
            label="Proposal title"
            name="title"
            required
            maxLength={PROPOSAL_TITLE_MAX}
            defaultValue={fieldValue(state, "title")}
            error={fieldError(state, "title")}
          />
        </>
      )}
    />
  );
}

export function EditProposalTitleDialog({
  proposal,
}: {
  proposal: { id: string; title: string };
}) {
  return (
    <ActionFormDialog
      formId={`proposal-form-edit-${proposal.id}`}
      title="Edit draft"
      description="Only the title of a draft can be changed."
      action={updateProposalTitleAction}
      submitLabel="Save title"
      pendingLabel="Saving…"
      hiddenFields={{ proposalId: proposal.id }}
      trigger={{
        label: (
          <>
            <Pencil aria-hidden="true" />
            <span className="md:max-lg:sr-only">Edit</span>
          </>
        ),
        variant: "rowAction",
        ariaLabel: `Edit draft ${proposal.title}`,
      }}
      renderFields={(state) => (
        <TextField
          label="Proposal title"
          name="title"
          required
          maxLength={PROPOSAL_TITLE_MAX}
          defaultValue={fieldValue(state, "title", proposal.title)}
          error={fieldError(state, "title")}
        />
      )}
    />
  );
}

// Permanent deletion with an explicit confirmation that names the proposal
// and its client. The server re-checks access and refuses proposals with
// payment records. `pending` is a deletion that started but didn't finish.
export function DeleteProposalDialog({
  proposal,
}: {
  proposal: { id: string; title: string; clientName: string; pending: boolean };
}) {
  return (
    <ActionFormDialog
      formId={`proposal-form-delete-${proposal.id}`}
      title={proposal.pending ? "Finish deleting this proposal?" : "Delete this proposal permanently?"}
      action={deleteProposalAction}
      submitLabel={proposal.pending ? "Retry deletion" : "Delete permanently"}
      pendingLabel="Deleting…"
      submitVariant="destructive"
      hiddenFields={{ proposalId: proposal.id }}
      trigger={{
        label: (
          <>
            <Trash2 aria-hidden="true" />
            <span className="md:max-lg:sr-only">{proposal.pending ? "Retry deletion" : "Delete"}</span>
          </>
        ),
        variant: "rowAction",
        ariaLabel: `${proposal.pending ? "Retry deleting" : "Delete"} proposal ${proposal.title}`,
      }}
      renderFields={() => (
        <div className="space-y-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border border-border bg-surface-muted px-4 py-3 text-[15px]">
            <dt className="text-muted">Proposal</dt>
            <dd className="break-words font-medium text-foreground">{proposal.title}</dd>
            <dt className="text-muted">Client</dt>
            <dd className="break-words font-medium text-foreground">{proposal.clientName}</dd>
          </dl>
          <div className={`${calloutStyles.error} space-y-2`}>
            <p className="font-medium">This can&apos;t be undone.</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>The proposal, its original PDF and its preview PDF (including earlier versions) are permanently removed.</li>
              <li>The client link stops working immediately and can&apos;t be restored.</li>
              <li>The client record and other proposals are kept.</li>
            </ul>
          </div>
          {proposal.pending ? (
            <p className={calloutStyles.neutral}>
              A previous deletion didn&apos;t finish. The proposal is already hidden from clients; retrying removes
              the remaining files and the record.
            </p>
          ) : null}
        </div>
      )}
    />
  );
}
