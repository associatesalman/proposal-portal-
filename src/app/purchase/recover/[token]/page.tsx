import { KeyRound, Link2Off } from "lucide-react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";

import { BrandMark } from "@/components/ui/brand";
import { ServiceUnavailable } from "@/components/ui/service-unavailable";
import { cardStyles, skeletonStyles } from "@/components/ui/styles";
import { hashRecoveryToken, isWellFormedRecoveryToken } from "@/lib/payments/recovery";
import { peekRecovery } from "@/lib/supabase/privileged-payments";

// /purchase/recover/<token>: a single-use access link (emailed, or created
// by the Team Lead on the dashboard). Opening it changes nothing; the
// button below POSTs to /claim, which redeems the token once and gives THIS
// browser access. Mail scanners that prefetch the link can't use it up.

export const metadata: Metadata = {
  title: "Restore access",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  referrer: "no-referrer",
};

export default function RecoverPage({ params }: PageProps<"/purchase/recover/[token]">) {
  return (
    <main data-client-page className="flex flex-1 flex-col bg-surface text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 w-full max-w-4xl items-center gap-2.5 px-4 sm:h-16">
          <BrandMark />
          <span className="text-sm font-semibold tracking-tight text-foreground">Restore access</span>
        </div>
      </header>
      <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:py-10">
        <Suspense fallback={<div className={`${skeletonStyles} mx-auto h-56 max-w-lg rounded-xl`} aria-busy="true" />}>
          <Recover params={params} />
        </Suspense>
      </div>
    </main>
  );
}

async function Recover({ params }: { params: PageProps<"/purchase/recover/[token]">["params"] }) {
  const { token } = await params;
  await connection();
  if (!isWellFormedRecoveryToken(token)) return <Expired />;

  const peek = await peekRecovery(hashRecoveryToken(token));
  if (!peek.ok) {
    return <ServiceUnavailable retryHref={`/purchase/recover/${token}`} message="This can't be checked right now. Please try again in a moment." />;
  }
  if (!peek.data) return <Expired />;

  return (
    <div className={`${cardStyles} mx-auto flex max-w-lg flex-col items-center gap-4 px-6 py-10 text-center`} data-recover-ready>
      <span className="flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent">
        <KeyRound className="size-5" aria-hidden="true" />
      </span>
      <h1 className="text-xl font-semibold tracking-tight">Restore access to your document</h1>
      <p className="break-words text-sm font-medium text-foreground">{peek.data.title}</p>
      <p className="text-sm text-muted">
        This opens the full document you purchased in this browser. The link works once.
      </p>
      <form method="post" action={`/purchase/recover/${token}/claim`}>
        <button
          type="submit"
          className="inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-accent px-5 text-base font-semibold text-accent-foreground shadow-card hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          data-recover-button
        >
          Restore access in this browser
        </button>
      </form>
    </div>
  );
}

function Expired() {
  return (
    <div className={`${cardStyles} mx-auto flex max-w-lg flex-col items-center gap-3 px-6 py-10 text-center`} data-recover-expired>
      <span className="flex size-10 items-center justify-center rounded-full bg-surface-sunken text-subtle">
        <Link2Off className="size-5" aria-hidden="true" />
      </span>
      <h1 className="text-xl font-semibold tracking-tight">This access link can&apos;t be used</h1>
      <p className="text-sm text-muted">
        It has expired or was already used. Ask the person who sent you the proposal for a new access link.
      </p>
    </div>
  );
}
