"use client";

import { Pencil, UserPlus } from "lucide-react";

import {
  createClientAction,
  updateClientAction,
} from "@/app/(dashboard)/dashboard/actions";
import { SelectField, TextField } from "@/components/ui/fields";
import type { TeamLeadOption } from "@/lib/dashboard/queries";
import { CLIENT_NAME_MAX } from "@/lib/validation/dashboard";

import { ActionFormDialog, fieldError, fieldValue } from "./action-form-dialog";

export function AddClientDialog({
  isAdmin,
  teamLeads,
  defaultOwnerId,
}: {
  isAdmin: boolean;
  teamLeads: TeamLeadOption[];
  defaultOwnerId?: string | null;
}) {
  const noLeads = isAdmin && teamLeads.length === 0;

  return (
    <ActionFormDialog
      formId="client-form-create"
      title="Add client"
      description={
        isAdmin
          ? "Create a client for one of the team leads."
          : "The client will be added to your account."
      }
      action={createClientAction}
      submitLabel="Add client"
      pendingLabel="Adding…"
      trigger={{
        label: (
          <>
            <UserPlus aria-hidden="true" />
            <span className="max-sm:sr-only">Add client</span>
          </>
        ),
        variant: "primary",
        disabled: noLeads,
      }}
      renderFields={(state) => (
        <>
          <TextField
            label="Client name"
            name="name"
            required
            maxLength={CLIENT_NAME_MAX}
            autoComplete="organization"
            defaultValue={fieldValue(state, "name")}
            error={fieldError(state, "name")}
          />
          <TextField
            label="Email"
            name="email"
            type="email"
            required
            maxLength={320}
            autoComplete="email"
            defaultValue={fieldValue(state, "email")}
            error={fieldError(state, "email")}
          />
          {isAdmin ? (
            <SelectField
              label="Team lead"
              name="ownerId"
              required
              placeholder="Select a team lead…"
              hint="The team lead who will own this client."
              options={teamLeads.map((lead) => ({ value: lead.id, label: lead.fullName }))}
              defaultValue={fieldValue(state, "ownerId", defaultOwnerId ?? "")}
              error={fieldError(state, "ownerId")}
            />
          ) : null}
        </>
      )}
    />
  );
}

export function EditClientDialog({
  client,
}: {
  client: { id: string; name: string; email: string };
}) {
  return (
    <ActionFormDialog
      formId={`client-form-edit-${client.id}`}
      title="Edit client"
      description="Update the client's name or email."
      action={updateClientAction}
      submitLabel="Save changes"
      pendingLabel="Saving…"
      hiddenFields={{ clientId: client.id }}
      trigger={{
        label: (
          <>
            <Pencil aria-hidden="true" />
            <span className="md:max-lg:sr-only">Edit</span>
          </>
        ),
        variant: "rowAction",
        ariaLabel: `Edit client ${client.name}`,
      }}
      renderFields={(state) => (
        <>
          <TextField
            label="Client name"
            name="name"
            required
            maxLength={CLIENT_NAME_MAX}
            defaultValue={fieldValue(state, "name", client.name)}
            error={fieldError(state, "name")}
          />
          <TextField
            label="Email"
            name="email"
            type="email"
            required
            maxLength={320}
            defaultValue={fieldValue(state, "email", client.email)}
            error={fieldError(state, "email")}
          />
        </>
      )}
    />
  );
}
