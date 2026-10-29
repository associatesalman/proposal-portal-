"use client";

import { Loader2, Mail } from "lucide-react";
import { useId, useState } from "react";

import { inputStyles } from "@/components/ui/styles";
import { useHydrated } from "@/components/ui/use-hydrated";

// "Already paid in another browser?" Sends a single-use link by email when
// the address matches a completed purchase of this proposal. The answer is
// the same whether or not it matched, and typing an address never grants
// access by itself: only opening the emailed link does.
export function RecoveryRequest({ token }: { token: string }) {
  const hydrated = useHydrated();
  const inputId = useId();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setState("sending");
    try {
      const response = await fetch(`/p/${token}/recover`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      setMessage(body?.message ?? "Something went wrong. Please try again.");
      setState(response.ok ? "sent" : "error");
    } catch {
      setMessage("We couldn't send the request. Check your connection and try again.");
      setState("error");
    }
  }

  return (
    <details className="group rounded-xl border border-border bg-surface p-4 sm:p-5" data-recovery>
      <summary className="cursor-pointer select-none text-sm font-semibold text-foreground">
        Already paid in another browser or device?
      </summary>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <label htmlFor={inputId} className="block text-sm text-muted">
          Enter the email address used for the payment, or the one the proposal was sent to. If it matches a completed
          payment, we&apos;ll email a one-time link that restores access in the browser where you open it.
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id={inputId}
            type="email"
            required
            maxLength={320}
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={`${inputStyles} sm:max-w-sm`}
          />
          <button
            type="submit"
            disabled={!hydrated || state === "sending"}
            className="inline-flex h-12 items-center justify-center gap-2 rounded-lg border border-border-strong bg-surface px-4 text-[15px] font-medium text-foreground shadow-card hover:border-accent-border hover:bg-accent-soft/60 hover:text-accent-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
          >
            {state === "sending" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Mail className="size-4" aria-hidden="true" />}
            Email me a link
          </button>
        </div>
        <p role="status" aria-live="polite" className={state === "error" ? "text-sm text-danger" : "text-sm text-muted"}>
          {state === "sent" || state === "error" ? message : ""}
        </p>
      </form>
    </details>
  );
}
