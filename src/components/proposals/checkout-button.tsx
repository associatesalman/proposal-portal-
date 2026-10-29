"use client";

import { AlertTriangle, Loader2, Lock } from "lucide-react";
import { useState } from "react";

import { useHydrated } from "@/components/ui/use-hydrated";

// "Pay with PayPal": asks the server to start PayPal Checkout for this link
// and then navigates to PayPal's approval page. The browser sends only the
// link (in the URL); the server reads the price, currency and document from
// the database. Before leaving, the client page's address is kept in
// sessionStorage so the purchase page can offer "Back to the proposal".
//
// Nothing here can mark a payment as paid: that happens only on the server
// after PayPal confirms the capture.

type State = { kind: "idle" } | { kind: "processing" } | { kind: "redirecting" } | { kind: "error"; message: string };

const FALLBACK_ERROR = "We couldn't start the payment. You haven't been charged. Please try again in a moment.";

export function CheckoutButton({ token, priceLabel }: { token: string; priceLabel: string }) {
  const hydrated = useHydrated();
  const [state, setState] = useState<State>({ kind: "idle" });
  const busy = state.kind === "processing" || state.kind === "redirecting";

  async function start() {
    setState({ kind: "processing" });
    try {
      const response = await fetch(`/p/${token}/checkout`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: "{}",
      });
      const body = (await response.json().catch(() => null)) as { url?: string; ref?: string; message?: string } | null;
      if (!response.ok || !body?.url) {
        setState({ kind: "error", message: body?.message ?? FALLBACK_ERROR });
        return;
      }
      try {
        if (body.ref) window.sessionStorage.setItem(`pp_return:${body.ref}`, window.location.pathname);
      } catch {
        // Storage can be unavailable (private mode); the link still works.
      }
      setState({ kind: "redirecting" });
      window.location.assign(body.url);
    } catch {
      setState({ kind: "error", message: FALLBACK_ERROR });
    }
  }

  return (
    <div className="space-y-3" data-checkout>
      <button
        type="button"
        onClick={start}
        disabled={!hydrated || busy}
        aria-describedby="checkout-help"
        className="inline-flex h-12 w-full select-none items-center justify-center gap-2 rounded-lg bg-accent px-5 text-base font-semibold text-accent-foreground shadow-card transition-[background-color,box-shadow,transform] duration-150 hover:bg-accent-hover hover:shadow-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60 sm:w-auto sm:min-w-64"
        data-pay-button
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Lock className="size-4" aria-hidden="true" />}
        {state.kind === "redirecting"
          ? "Opening PayPal…"
          : state.kind === "processing"
            ? "Preparing payment…"
            : "Pay with PayPal"}
      </button>
      <p id="checkout-help" className="text-sm text-muted">
        You&apos;ll pay {priceLabel} securely on PayPal, then return here. The full document unlocks in this browser
        once PayPal confirms the payment.
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        {state.kind === "processing" ? "Preparing payment" : state.kind === "redirecting" ? "Opening PayPal" : ""}
      </p>
      {state.kind === "error" ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
