"use client";

import { AlertCircle, Loader2 } from "lucide-react";
import { useActionState, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Dialog } from "@/components/ui/dialog";
import { buttonStyles, calloutStyles, type ButtonVariant } from "@/components/ui/styles";
import { useHydrated } from "@/components/ui/use-hydrated";
import { initialFormState, type FormState } from "@/lib/dashboard/form-state";

import { useFeedback } from "./feedback";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

type ActionFormDialogProps = {
  formId: string;
  title: string;
  description?: string;
  action: Action;
  submitLabel: string;
  pendingLabel: string;
  // "destructive" for irreversible actions (permanent deletion).
  submitVariant?: "primary" | "destructive";
  trigger: {
    label: ReactNode;
    variant: ButtonVariant;
    ariaLabel?: string;
    disabled?: boolean;
  };
  hiddenFields?: Record<string, string>;
  renderFields: (state: FormState) => ReactNode;
};

export function ActionFormDialog({ trigger, title, description, ...formProps }: ActionFormDialogProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // A new key per opening gives a fresh form (no stale errors or values).
  const [formKey, setFormKey] = useState(0);
  // The dialog needs JavaScript; until then the trigger is visibly disabled
  // rather than ignoring clicks.
  const hydrated = useHydrated();

  return (
    <>
      <button
        type="button"
        className={buttonStyles[trigger.variant]}
        aria-label={trigger.ariaLabel}
        aria-haspopup="dialog"
        disabled={trigger.disabled || !hydrated}
        onClick={() => {
          setFormKey((key) => key + 1);
          setOpen(true);
        }}
      >
        {trigger.label}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={title} description={description} busy={busy}>
        <ActionForm key={formKey} {...formProps} onDone={() => setOpen(false)} onPendingChange={setBusy} />
      </Dialog>
    </>
  );
}

function ActionForm({
  formId,
  action,
  submitLabel,
  pendingLabel,
  submitVariant = "primary",
  hiddenFields,
  renderFields,
  onDone,
  onPendingChange,
}: Omit<ActionFormDialogProps, "trigger" | "title" | "description"> & {
  onDone: () => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const notify = useFeedback();
  const hydrated = useHydrated();
  // The server HTML uses the server action itself, so the form keeps working
  // as a plain POST before hydration. Once interactive, the toast is raised
  // from the action rather than from this form, so it still appears when the
  // saved record leaves the current list (e.g. a renamed client no longer
  // matches the search) and this dialog unmounts with its row.
  const notifyingAction = async (previous: FormState, formData: FormData) => {
    const result = await action(previous, formData);
    if (result.status === "success") notify(result.message);
    return result;
  };
  const [state, formAction, pending] = useActionState(hydrated ? notifyingAction : action, initialFormState);
  const handledSubmission = useRef<string | null>(null);
  const onDoneRef = useRef(onDone);

  useEffect(() => {
    onDoneRef.current = onDone;
  });

  // Layout effect: the dialog is marked busy (Escape and Close blocked) in the
  // same paint that shows the pending state.
  useLayoutEffect(() => {
    onPendingChange(pending);
  }, [pending, onPendingChange]);

  useEffect(() => {
    if (state.status === "success" && handledSubmission.current !== state.submissionId) {
      handledSubmission.current = state.submissionId;
      onDoneRef.current();
    }
  }, [state]);

  return (
    <form id={formId} action={formAction} className="space-y-6" aria-busy={pending || undefined}>
      {Object.entries(hiddenFields ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      {state.status === "error" ? (
        <p role="alert" className={`${calloutStyles.error} flex items-start gap-2`}>
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{state.message}</span>
        </p>
      ) : null}

      {/* Also shown inline so the outcome is visible without JavaScript. */}
      {state.status === "success" ? <p className={calloutStyles.success}>{state.message}</p> : null}

      {/* Disabling the fieldset while pending prevents edits and double submits;
          values entered before an error are sent back and shown again. */}
      <fieldset disabled={pending} className="space-y-5">
        {renderFields(state)}
      </fieldset>

      <div className="-mx-5 flex flex-col-reverse gap-3 border-t border-border px-5 pt-6 sm:-mx-8 sm:flex-row sm:justify-end sm:px-8">
        <button type="button" className={buttonStyles.secondary} onClick={onDone} disabled={pending}>
          Cancel
        </button>
        <button type="submit" className={buttonStyles[submitVariant]} disabled={pending}>
          {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          {pending ? pendingLabel : submitLabel}
        </button>
      </div>
    </form>
  );
}

// Helper for field errors/values from the last submission.
export function fieldError(state: FormState, field: string): string | undefined {
  return state.status === "error" ? state.fieldErrors?.[field] : undefined;
}

export function fieldValue(state: FormState, field: string, fallback = ""): string {
  return state.status === "error" ? (state.values[field] ?? fallback) : fallback;
}
