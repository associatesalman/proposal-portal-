"use client";

import { AlertCircle, Check, Copy, KeyRound, Loader2 } from "lucide-react";
import { useState, useTransition } from "react";

import { issueRecoveryLinkAction, type RecoveryLinkResult } from "@/app/(dashboard)/dashboard/payment-actions";
import { Dialog } from "@/components/ui/dialog";
import { buttonStyles, calloutStyles, controlStyles } from "@/components/ui/styles";
import { useHydrated } from "@/components/ui/use-hydrated";
import { formatDateTime } from "@/lib/format";

// Creates a single-use access link for a completed payment and shows it
// once, for the Team Lead to send to the client personally. Opening the
// link and confirming restores the paid PDF in that browser.
export function RecoveryLinkDialog({
  payment,
}: {
  payment: { id: string; title: string; clientName: string };
}) {
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<RecoveryLinkResult | null>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [pending, startTransition] = useTransition();

  function create() {
    startTransition(async () => {
      setResult(await issueRecoveryLinkAction({ paymentId: payment.id }));
    });
  }

  return (
    <>
      <button
        type="button"
        className={buttonStyles.rowAction}
        aria-haspopup="dialog"
        aria-label={`Create access link for ${payment.title}`}
        disabled={!hydrated}
        onClick={() => {
          setResult(null);
          setCopy("idle");
          setOpen(true);
        }}
      >
        <KeyRound aria-hidden="true" />
        <span className="md:max-lg:sr-only">Access link</span>
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        busy={pending}
        title="Create an access link"
        description="For a client who paid but can't open the full document in their current browser."
      >
        <div className="space-y-5">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border border-border bg-surface-muted px-4 py-3 text-[15px]">
            <dt className="text-muted">Proposal</dt>
            <dd className="break-words font-medium text-foreground">{payment.title}</dd>
            <dt className="text-muted">Client</dt>
            <dd className="break-words font-medium text-foreground">{payment.clientName}</dd>
          </dl>

          {result?.ok ? (
            <div className="space-y-3">
              <label htmlFor={`recovery-${payment.id}`} className="block text-[15px] font-medium text-foreground">
                Access link (shown only now)
              </label>
              <input
                id={`recovery-${payment.id}`}
                readOnly
                value={result.url}
                onFocus={(event) => event.currentTarget.select()}
                className={`${controlStyles} h-12 px-3 font-mono text-sm`}
                data-recovery-link
              />
              <button
                type="button"
                className={buttonStyles.secondary}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(result.url);
                    setCopy("copied");
                  } catch {
                    setCopy("failed");
                  }
                }}
              >
                {copy === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                {copy === "copied" ? "Copied" : "Copy link"}
              </button>
              <p className="text-sm text-muted" aria-live="polite">
                {copy === "failed" ? "Copying isn't available here; select the link and copy it. " : ""}
                It works once, until {formatDateTime(result.expiresAt)}. Send it only to the client.
              </p>
            </div>
          ) : (
            <ul className={`${calloutStyles.neutral} list-disc space-y-1 pl-8`}>
              <li>The link works once and expires after 3 days.</li>
              <li>Whoever opens it gets the paid document in their browser, so send it only to the client.</li>
              <li>Creating a link doesn&apos;t change the payment.</li>
            </ul>
          )}

          {result && !result.ok ? (
            <p role="alert" className={`${calloutStyles.error} flex items-start gap-2`}>
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{result.message}</span>
            </p>
          ) : null}

          <div className="-mx-5 flex flex-col-reverse gap-3 border-t border-border px-5 pt-6 sm:-mx-8 sm:flex-row sm:justify-end sm:px-8">
            <button type="button" className={buttonStyles.secondary} onClick={() => setOpen(false)} disabled={pending}>
              {result?.ok ? "Done" : "Cancel"}
            </button>
            {!result?.ok ? (
              <button type="button" className={buttonStyles.primary} onClick={create} disabled={pending}>
                {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                {pending ? "Creating…" : "Create link"}
              </button>
            ) : null}
          </div>
        </div>
      </Dialog>
    </>
  );
}
