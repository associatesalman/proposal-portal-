import { CheckCircle2, Lock } from "lucide-react";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";

import { PreviewViewer } from "@/components/proposals/preview-viewer";
import { PurchaseStatus } from "@/components/proposals/purchase-status";
import { BrandMark } from "@/components/ui/brand";
import { ServiceUnavailable } from "@/components/ui/service-unavailable";
import { cardStyles, skeletonStyles } from "@/components/ui/styles";
import { readSessionHash } from "@/lib/payments/browser-session";
import { isPublicRef } from "@/lib/payments/refs";
import { clientState } from "@/lib/payments/service";
import { formatPrice, isCurrencyCode } from "@/lib/proposals/currencies";
import { paymentForSession } from "@/lib/supabase/privileged-payments";

// /purchase/<ref>: where PayPal sends the buyer back (return and cancel
// URLs), and the bookmarkable home of a purchase. It works only in the
// browser that started the checkout or that holds paid access to it; a
// forwarded URL shows the same "not available" page as an unknown one.
// The ?result= marker only chooses which check to run first; it never
// changes a payment. Full access is shown only for a purchase the database
// holds as verified with an active entitlement for this browser.

export const metadata: Metadata = {
  title: "Your purchase",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  referrer: "no-referrer",
};

export default function PurchasePage({ params, searchParams }: PageProps<"/purchase/[ref]">) {
  return (
    <main data-client-page className="flex flex-1 flex-col bg-surface text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 w-full max-w-4xl items-center gap-2.5 px-4 sm:h-16">
          <BrandMark />
          <span className="text-sm font-semibold tracking-tight text-foreground">Your purchase</span>
        </div>
      </header>
      <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:py-8">
        <Suspense fallback={<Fallback />}>
          <Purchase params={params} searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
  );
}

async function Purchase({
  params,
  searchParams,
}: {
  params: PageProps<"/purchase/[ref]">["params"];
  searchParams: PageProps<"/purchase/[ref]">["searchParams"];
}) {
  const { ref } = await params;
  await connection();
  const raw = (await searchParams).result;
  const result = raw === "return" ? "return" : raw === "cancel" ? "cancel" : null;

  const sessionHash = readSessionHash(await cookies());
  if (!isPublicRef(ref) || !sessionHash) return <NotAvailable />;

  const view = await paymentForSession(ref, sessionHash);
  if (!view.ok) {
    return <ServiceUnavailable retryHref={`/purchase/${ref}`} message="Your purchase can't be loaded right now. Please try again in a moment." />;
  }
  const payment = view.data;
  if (!payment) return <NotAvailable />;

  const state = clientState(payment);
  const price = isCurrencyCode(payment.currency) ? formatPrice(payment.amount_minor, payment.currency) : null;

  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="min-w-0 space-y-1.5">
        <h1 className="break-words text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{payment.title}</h1>
        {price ? (
          <p className="text-sm text-muted">
            {price} ({payment.currency}) · Full document, {payment.total_pages} pages
          </p>
        ) : null}
      </div>

      {state === "completed" && payment.has_access ? (
        <>
          <p
            className="flex items-start gap-2 rounded-lg border border-success-border bg-success-soft px-3 py-2 text-sm font-medium text-success"
            data-payment-success
          >
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            Payment received successfully. The full document is unlocked in this browser.
          </p>
          <PreviewViewer
            previewUrl={`/purchase/${ref}/document`}
            freePages={payment.total_pages}
            totalPages={payment.total_pages}
            variant="full"
            downloadUrl={`/purchase/${ref}/document?download=1`}
          />
          <p className="text-xs text-subtle">
            Bookmark this page to return to your document in this browser. Forwarding it doesn&apos;t give anyone else
            access.
          </p>
        </>
      ) : (
        <PurchaseStatus
          publicRef={ref}
          initialState={state === "completed" ? "verifying" : state}
          result={payment.bound ? result : null}
        />
      )}
    </div>
  );
}

function NotAvailable() {
  return (
    <Centered>
      <span className="flex size-10 items-center justify-center rounded-full bg-surface-sunken text-subtle">
        <Lock className="size-5" aria-hidden="true" />
      </span>
      <h1 className="text-xl font-semibold tracking-tight">This purchase isn&apos;t available in this browser</h1>
      <p className="text-sm text-muted">
        Purchases open only in the browser where the payment was made. If you paid in another browser or device, open
        the proposal link there, or ask the person who sent you the link for an access link.
      </p>
    </Centered>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className={`${cardStyles} mx-auto flex max-w-lg flex-col items-center gap-3 px-6 py-10 text-center`} data-purchase-unavailable>
      {children}
    </div>
  );
}

function Fallback() {
  return (
    <div className="space-y-5" aria-busy="true">
      <p className="sr-only" role="status">
        Loading your purchase…
      </p>
      <div className={`${skeletonStyles} h-8 w-2/3`} aria-hidden="true" />
      <div className={`${skeletonStyles} h-40 rounded-xl`} aria-hidden="true" />
    </div>
  );
}
