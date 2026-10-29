"use client";

import { UserPen } from "lucide-react";

import { updateDisplayNameAction } from "@/app/(dashboard)/dashboard/actions";
import { TextField } from "@/components/ui/fields";
import { DISPLAY_NAME_MAX } from "@/lib/validation/dashboard";

import { ActionFormDialog, fieldError, fieldValue } from "./action-form-dialog";

// The signed-in user's own display name (profiles.full_name). The server
// updates only that column of the user's own profile; role is not editable.
export function EditDisplayNameDialog({ fullName }: { fullName: string }) {
  return (
    <ActionFormDialog
      formId="profile-form-name"
      title="Edit display name"
      description="Shown in the dashboard header and, for the CEO, as the owner of your clients and proposals. Clients never see it. Your role doesn't change."
      action={updateDisplayNameAction}
      submitLabel="Save name"
      pendingLabel="Saving…"
      trigger={{
        label: (
          <>
            <UserPen aria-hidden="true" />
            <span className="max-sm:sr-only">Edit name</span>
          </>
        ),
        variant: "rowAction",
        ariaLabel: "Edit display name",
      }}
      renderFields={(state) => (
        <TextField
          label="Display name"
          name="fullName"
          required
          maxLength={DISPLAY_NAME_MAX}
          autoComplete="name"
          hint="For example “Fassih Team Lead”."
          defaultValue={fieldValue(state, "fullName", fullName)}
          error={fieldError(state, "fullName")}
        />
      )}
    />
  );
}
