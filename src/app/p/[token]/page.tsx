import { CheckCircle2, Link2Off, Lock } from "lucide-react";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { CheckoutButton } from "@/components/proposals/checkout-button";
import { LockedPagePlaceholders } from "@/components/proposals/locked-pages";
import { PreviewViewer } from "@/components/proposals/preview-viewer";
import { formatLabel, type SourceFormat } from "@/lib/documents/formats";
import { RecoveryRequest } from "@/components/proposals/recovery-request";
import { BrandMark } from "@/components/ui/brand";
import { ServiceUnavailable } from "@/components/ui/service-unavailable";
import { cardStyles, skeletonStyles } from "@/components/ui/styles";
import { readSessionHash } from "@/lib/payments/browser-session";
import { getPaymentConfigState, warnIfIncomplete } from "@/lib/payments/config";
import { isRecoveryEmailConfigured } from "@/lib/payments/email";
import { isPayPalCurrency } from "@/lib/payments/money";
import { formatPrice, type CurrencyCode } from "@/lib/proposals/currencies";
import { resolveProposalLink } from "@/lib/proposals/resolve-link";
import { recordLinkMiss } from "@/lib/security/public-limits";
import { accessForLink } from "@/lib/supabase/privileged-payments";

// Client proposal page (no login). The link token is the only credential:
// anyone holding the link can read the free preview, so it shows nothing
// beyond the title, page counts and unlock price. No client email, owner
// (Team Lead name or email), ids, storage paths, history, payments or hashes
// ever reach this page. Locked pages appear as synthetic placeholders built
// from the counts alone; the preview PDF contains only the free pages.
//
// The page resolves the token on every request (nothing is cached), and the
// preview PDF is fetched separately from /p/<token>/preview, which checks
// the token again. Invalid, revoked and inactive links all render the same
// "unavailable" state, so the page never reveals whether a proposal exists.
// If the database can't be reached, a "temporarily unavailable" state with
// a retry is shown instead. Page requests are rate-limited in src/proxy.ts.
// Response headers (no-store, no-referrer, noindex) are set in
// next.config.ts.
//
// Full Access links (granted manually in the dashboard, e.g. after an
// offline payment): the database says the link is in Full Access mode, and
// the page shows the complete document with "Download PDF" (and "Download
// original" when the upload wasn't a PDF). No preview split, price, locked
// pages or payment panel. The mode is never taken from the URL: a preview
// link can't be turned into a Full Access one by any parameter.
//
// Payments: a browser that holds paid access to this proposal (its HttpOnly
// session cookie has an access session for an active purchase) sees the
// complete purchased PDF instead of the preview. Everyone else, including
// anyone the link was forwarded to, sees the preview and the payment panel:
// "Pay with PayPal" when payments are fully configured and the currency is
// supported, otherwise a notice. "Payment received successfully" is shown
// only for a purchase the database holds as verified.

export const metadata: Metadata = {
  title: "Proposal",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  referrer: "no-referrer",
};

export default function ProposalLinkPage({ params }: PageProps<"/p/[token]">) {
  return (
    <main data-client-page className="flex flex-1 flex-col bg-surface text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-2.5 px-4 sm:h-16">
          <BrandMark />
          <span className="text-sm font-semibold tracking-tight text-foreground">Private proposal</span>
        </div>
      </header>
      <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:py-8">
        <Suspense fallback={<ProposalFallback />}>
          <ResolvedProposal params={params} />
        </Suspense>
      </div>
    </main>
  );
}

async function ResolvedProposal({ params }: { params: PageProps<"/p/[token]">["params"] }) {
  const { token } = await params;
  // Resolve only for a real request, never in a prerender/prefetch pass.
  await connection();
  const resolution = await resolveProposalLink(token);

  if (resolution.status === "error") {
    return (
      <ServiceUnavailable
        retryHref={`/p/${token}`}
        message="This proposal can't be loaded right now. Please try again in a moment."
      />
    );
  }

  if (resolution.status === "not_found") {
    // Counts toward this address's limit on lookups of unknown links.
    const misses = await recordLinkMiss(await headers());
    if (misses.status === "limited") {
      return (
        <ServiceUnavailable
          retryHref={`/p/${token}`}
          title="Too many attempts"
          message="Too many unavailable links were opened from your network in a short period. Wait a few minutes, then check the link and try again."
        />
      );
    }
    return (
      <div className={`${cardStyles} mx-auto flex max-w-lg flex-col items-center gap-3 px-6 py-10 text-center`}>
        <span className="flex size-10 items-center justify-center rounded-full bg-surface-sunken text-subtle">
          <Link2Off className="size-5" aria-hidden="true" />
        </span>
        <h1 className="text-xl font-semibold tracking-tight">This link isn&apos;t available</h1>
        <p className="text-sm text-muted">
          The link may be mistyped, or it may no longer be active. Please contact the person who sent it to you.
        </p>
      </div>
    );
  }

  if (resolution.status === "full") {
    const { title, totalPages, sourceFormat } = resolution.document;
    return <FullAccessProposal token={token} title={title} totalPages={totalPages} sourceFormat={sourceFormat} />;
  }

  const { title, totalPages, freePages, lockedPages, priceMinor, currency } = resolution.proposal;
  const firstLocked = freePages + 1;

  // Paid access for THIS browser (never inferred from the link alone). A
  // lookup failure falls back to the preview (fail closed).
  const sessionHash = readSessionHash(await cookies());
  const purchases = sessionHash ? await accessForLink(token, sessionHash) : null;
  const purchase = purchases?.ok ? purchases.data[0] : undefined;
  if (purchase) {
    return <PaidProposal title={title} publicRef={purchase.public_ref} totalPages={purchase.total_pages} currentRevision={purchase.current_revision} />;
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0 space-y-1.5">
          <h1 className="break-words text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{title}</h1>
          <p className="text-sm text-muted" data-preview-summary>
            Free preview: {freePages} of {totalPages} pages.
          </p>
        </div>

        <dl className="grid shrink-0 grid-cols-3 gap-2 text-sm md:w-[25rem]">
          <PageCount label="Preview pages" value={freePages} tone="accent" />
          <PageCount label="Total pages" value={totalPages} />
          <PageCount label="Locked pages" value={lockedPages} />
        </dl>
      </div>

      <PreviewViewer previewUrl={`/p/${token}/preview`} freePages={freePages} totalPages={totalPages} />

      {/* Synthetic placeholders from the page counts only (no locked content). */}
      <LockedPagePlaceholders
        freePages={freePages}
        totalPages={totalPages}
        unlockable={getPaymentConfigState().status === "ready" && isPayPalCurrency(currency)}
      />

      <section
        aria-labelledby="unlock-heading"
        className="space-y-2 rounded-xl border border-accent-border bg-accent-soft p-4 sm:p-5"
      >
        <h2 id="unlock-heading" className="flex items-center gap-2.5 text-base font-semibold text-foreground">
          <span className="flex size-7 items-center justify-center rounded-full bg-surface text-accent shadow-card">
            <Lock className="size-3.5" aria-hidden="true" />
          </span>
          {lockedPages} {lockedPages === 1 ? "page is" : "pages are"} locked
        </h2>
        <p className="text-sm text-muted" data-locked-notice>
          {lockedPages === 1
            ? `Page ${firstLocked} of ${totalPages} is not included in this preview.`
            : `Pages ${firstLocked}–${totalPages} of ${totalPages} are not included in this preview.`}{" "}
          The full document can be unlocked for{" "}
          <strong className="font-semibold text-foreground" data-price>
            {formatPrice(priceMinor, currency)}
          </strong>{" "}
          <span className="text-muted">({currency})</span>.
        </p>
        <PaymentPanel token={token} priceMinor={priceMinor} currency={currency} />
      </section>

      <p className="text-xs text-subtle">
        This page is private to whoever holds the link. Anyone you forward it to can open the same preview.
      </p>
    </div>
  );
}

function PaymentPanel({ token, priceMinor, currency }: { token: string; priceMinor: number; currency: CurrencyCode }) {
  const state = getPaymentConfigState();
  if (state.status !== "ready") {
    if (state.status === "incomplete") warnIfIncomplete();
    return (
      <p className="text-sm font-medium text-accent-strong" data-payment-notice>
        Online payment will be available soon.
      </p>
    );
  }
  if (!isPayPalCurrency(currency)) {
    return (
      <p className="text-sm font-medium text-accent-strong" data-payment-notice>
        Online payment isn&apos;t available for {currency}. Please contact the person who sent you this link.
      </p>
    );
  }
  return (
    <div className="space-y-4 pt-2">
      <CheckoutButton token={token} priceLabel={formatPrice(priceMinor, currency)} />
      {isRecoveryEmailConfigured() ? (
        <RecoveryRequest token={token} />
      ) : (
        <p className="text-sm text-muted">
          Already paid in another browser or device? Ask the person who sent you this link for an access link.
        </p>
      )}
    </div>
  );
}

function PaidProposal({
  title,
  publicRef,
  totalPages,
  currentRevision,
}: {
  title: string;
  publicRef: string;
  totalPages: number;
  currentRevision: boolean;
}) {
  return (
    <div className="space-y-5 sm:space-y-6" data-paid-view>
      <div className="min-w-0 space-y-3">
        <h1 className="break-words text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{title}</h1>
        <p
          className="flex items-start gap-2 rounded-lg border border-success-border bg-success-soft px-3 py-2 text-sm font-medium text-success"
          data-payment-success
        >
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          Payment received successfully. The full document is unlocked in this browser.
        </p>
        {!currentRevision ? (
          <p className="text-sm text-muted">This is the version of the document you purchased.</p>
        ) : null}
      </div>
      <PreviewViewer
        previewUrl={`/purchase/${publicRef}/document`}
        freePages={totalPages}
        totalPages={totalPages}
        variant="full"
      />
      <p className="text-xs text-subtle">
        Bookmark{" "}
        <Link href={`/purchase/${publicRef}`} className="font-medium text-accent underline-offset-2 hover:underline">
          your purchase page
        </Link>{" "}
        to come back to this document in this browser. Forwarding the link doesn&apos;t give anyone else access.
      </p>
    </div>
  );
}

function FullAccessProposal({
  token,
  title,
  totalPages,
  sourceFormat,
}: {
  token: string;
  title: string;
  totalPages: number;
  sourceFormat: SourceFormat | null;
}) {
  return (
    <div className="space-y-5 sm:space-y-6" data-full-access-view>
      <div className="min-w-0 space-y-1.5">
        <h1 className="break-words text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{title}</h1>
        <p className="text-sm text-muted" data-full-summary>
          Full document: {totalPages} {totalPages === 1 ? "page" : "pages"}. You can read it here or download it.
        </p>
      </div>
      <PreviewViewer
        previewUrl={`/p/${token}/document`}
        freePages={totalPages}
        totalPages={totalPages}
        variant="full"
        downloads={{
          pdfUrl: `/p/${token}/download`,
          original: sourceFormat ? { url: `/p/${token}/original`, label: formatLabel(sourceFormat) } : undefined,
        }}
      />
      <p className="text-xs text-subtle">
        This page is private to whoever holds the link: anyone you forward it to can read and download the full
        document.
      </p>
    </div>
  );
}

function PageCount({ label, value, tone }: { label: string; value: number; tone?: "accent" }) {
  return (
    <div className={`${cardStyles} px-3 py-2.5`}>
      <dt className="truncate text-xs text-muted">{label}</dt>
      <dd className={`text-lg font-semibold tabular-nums ${tone === "accent" ? "text-accent" : "text-foreground"}`}>
        {value}
      </dd>
    </div>
  );
}

// Roughly the size of the loaded page, so it doesn't jump when it arrives.
function ProposalFallback() {
  return (
    <div className="space-y-5 sm:space-y-6" aria-busy="true">
      <p className="sr-only" role="status">
        Loading proposal…
      </p>
      <div className="space-y-2" aria-hidden="true">
        <div className={`${skeletonStyles} h-8 w-2/3`} />
        <div className={`${skeletonStyles} h-4 w-48`} />
      </div>
      <div className={`${skeletonStyles} h-[420px] rounded-xl`} aria-hidden="true" />
    </div>
  );
}
