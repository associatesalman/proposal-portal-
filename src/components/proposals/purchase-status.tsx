"use client";

import { AlertTriangle, ArrowLeft, CheckCircle2, Clock, ExternalLink, Loader2, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

// Live state of one purchase for the browser that started it. After PayPal
// sends the buyer back it asks the server to capture and verify, then polls
// (bounded, paused while the tab is hidden, stopped on unmount) until the
// payment is final. "Payment received successfully" appears only when the
// server reports a verified payment with access for this browser; the page
// is then re-rendered on the server with the full document.

type ClientState = "awaiting_approval" | "pending" | "verifying" | "completed" | "cancelled" | "failed" | "refunded";

type StatusResponse = {
  state: ClientState;
  hasAccess: boolean;
  declined: boolean;
  retryLater: boolean;
  approveUrl: string | null;
};

const OPEN: ClientState[] = ["awaiting_approval", "pending", "verifying"];
// ~1 minute at 3 s, then ~9 minutes at 15 s.
const FAST_POLLS = 20;
const MAX_POLLS = 56;

export function PurchaseStatus({
  publicRef,
  initialState,
  result,
}: {
  publicRef: string;
  initialState: ClientState;
  result: "return" | "cancel" | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<ClientState>(initialState);
  const [approveUrl, setApproveUrl] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);
  const [checking, setChecking] = useState(true);
  const [exhausted, setExhausted] = useState(false);
  const backHref = useSyncExternalStore(
    noSubscription,
    () => storedProposalPath(publicRef),
    () => null,
  );
  const polls = useRef(0);

  useEffect(() => {
    // The return/cancel marker is acted on once; a reload just re-checks.
    if (result) window.history.replaceState(null, "", `/purchase/${publicRef}`);
  }, [publicRef, result]);

  useEffect(() => {
    let disposed = false;
    let stopped = false;
    let paused = false;
    let timer: number | undefined;
    let action: "capture" | "refresh" | "cancel" = result === "cancel" ? "cancel" : result === "return" ? "capture" : "refresh";

    async function check() {
      timer = undefined;
      if (disposed || stopped) return;
      if (document.visibilityState !== "visible") {
        paused = true; // resumed on visibilitychange
        return;
      }
      setChecking(true);
      let next: StatusResponse | null = null;
      try {
        const response = await fetch(`/purchase/${publicRef}/status`, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ action }),
        });
        if (response.ok) next = (await response.json()) as StatusResponse;
      } catch {
        next = null;
      }
      if (disposed) return;
      action = "refresh";
      setChecking(false);
      polls.current += 1;

      if (next) {
        setState(next.state);
        setApproveUrl(next.approveUrl);
        setDeclined(next.declined);
        if (next.state === "completed" && next.hasAccess) {
          stopped = true;
          router.refresh();
          return;
        }
        if (!OPEN.includes(next.state) && !next.retryLater) {
          stopped = true;
          return;
        }
      }
      if (polls.current >= MAX_POLLS) {
        stopped = true;
        setExhausted(true);
        return;
      }
      timer = window.setTimeout(check, polls.current < FAST_POLLS ? 3_000 : 15_000);
    }

    function onVisibility() {
      if (document.visibilityState === "visible" && paused) {
        paused = false;
        void check();
      }
    }

    timer = window.setTimeout(check, 0);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [publicRef, result, router]);

  const back = backHref ? (
    <a href={backHref} className={secondaryLink}>
      <ArrowLeft className="size-4" aria-hidden="true" />
      Back to the proposal
    </a>
  ) : null;

  const retry = approveUrl ? (
    <a href={approveUrl} className={primaryLink} data-retry-paypal>
      <ExternalLink className="size-4" aria-hidden="true" />
      Continue on PayPal
    </a>
  ) : null;

  return (
    <div aria-live="polite" data-purchase-state={state}>
      {state === "completed" ? (
        <Panel tone="success" icon={<CheckCircle2 className="size-5" aria-hidden="true" />} title="Payment received successfully">
          Opening the full document…
        </Panel>
      ) : state === "pending" ? (
        <Panel tone="info" icon={<Clock className="size-5" aria-hidden="true" />} title="Payment pending verification">
          PayPal is still processing this payment. The document unlocks automatically once PayPal confirms it. You
          won&apos;t be charged twice; you can leave this page and come back to it in this browser.
        </Panel>
      ) : state === "verifying" ? (
        <Panel tone="info" icon={<Spinner />} title="Confirming your payment with PayPal…">
          This usually takes a few seconds. Please keep this page open.
        </Panel>
      ) : state === "cancelled" ? (
        <Panel tone="neutral" icon={<XCircle className="size-5" aria-hidden="true" />} title="Payment cancelled">
          You haven&apos;t been charged. You can return to the proposal and pay whenever you&apos;re ready.
          <Actions>
            {back}
            {retry}
          </Actions>
        </Panel>
      ) : state === "failed" ? (
        <Panel tone="danger" icon={<AlertTriangle className="size-5" aria-hidden="true" />} title="Payment failed">
          PayPal didn&apos;t complete this payment, so you haven&apos;t been charged and the document stays locked. You
          can try again from the proposal.
          <Actions>{back}</Actions>
        </Panel>
      ) : state === "refunded" ? (
        <Panel tone="neutral" icon={<XCircle className="size-5" aria-hidden="true" />} title="Payment refunded">
          This payment was refunded or reversed, so access to the full document has ended.
          <Actions>{back}</Actions>
        </Panel>
      ) : (
        <Panel
          tone="info"
          icon={checking ? <Spinner /> : <Clock className="size-5" aria-hidden="true" />}
          title={checking ? "Processing your payment…" : declined ? "Your payment method was declined" : "Payment not completed yet"}
        >
          {declined
            ? "PayPal declined the payment method. Continue on PayPal to choose another one; you haven't been charged."
            : checking
              ? "Checking with PayPal. Please keep this page open."
              : "We haven't received a completed payment from PayPal yet. If you approved it, this page updates automatically."}
          <Actions>
            {retry}
            {back}
          </Actions>
        </Panel>
      )}
      {exhausted ? (
        <p className="mt-3 text-sm text-muted">
          Automatic checking has stopped. Reload this page to check again.
        </p>
      ) : null}
    </div>
  );
}

function noSubscription() {
  return () => {};
}

// The proposal page this checkout started from (set by CheckoutButton in
// this tab), for the "Back to the proposal" link.
function storedProposalPath(publicRef: string): string | null {
  try {
    const stored = window.sessionStorage.getItem(`pp_return:${publicRef}`);
    return stored && /^\/p\/[A-Za-z0-9_-]{43}$/.test(stored) ? stored : null;
  } catch {
    return null; // No storage: no back link.
  }
}

const linkBase =
  "inline-flex h-11 items-center justify-center gap-2 rounded-lg px-4 text-[15px] font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const primaryLink = `${linkBase} bg-accent text-accent-foreground shadow-card hover:bg-accent-hover`;
const secondaryLink = `${linkBase} border border-border-strong bg-surface text-foreground shadow-card hover:border-accent-border hover:bg-accent-soft/60 hover:text-accent-strong`;

function Spinner() {
  return <Loader2 className="size-5 animate-spin" aria-hidden="true" />;
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="mt-4 flex flex-col gap-3 empty:hidden sm:flex-row">{children}</div>;
}

const TONES = {
  success: "border-success-border bg-success-soft text-success",
  info: "border-accent-border bg-accent-soft text-accent-strong",
  neutral: "border-border bg-surface-muted text-foreground",
  danger: "border-danger-border bg-danger-soft text-danger",
} as const;

function Panel({
  tone,
  icon,
  title,
  children,
}: {
  tone: keyof typeof TONES;
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className={`rounded-xl border p-4 sm:p-5 ${TONES[tone]}`}>
      <h2 className="flex items-center gap-2.5 text-base font-semibold" data-purchase-title>
        {icon}
        {title}
      </h2>
      <div className="mt-2 text-sm text-muted">{children}</div>
    </section>
  );
}
