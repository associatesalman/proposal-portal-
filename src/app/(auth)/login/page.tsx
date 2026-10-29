import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { BrandMark } from "@/components/ui/brand";
import { calloutStyles, skeletonStyles } from "@/components/ui/styles";
import { getSafeRedirectPath } from "@/lib/auth/redirect";
import { getAuthState } from "@/lib/auth/session";
import { isSupabaseConfigured } from "@/lib/supabase/config";

import { LoginArt } from "./login-art";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in · Editorial Proposal Portal",
  robots: { index: false, follow: false },
};

const UNAVAILABLE_NOTICE =
  "The sign-in service isn't responding right now, so your session couldn't be checked. You can try signing in, or reload the page in a moment.";

const NO_ACCESS_NOTICE =
  "This account is not authorized to use the portal. Contact your administrator.";

// Two columns from 1024 px: the portal heading and artwork on the left, the
// sign-in panel on the right. Below that the layout stacks with the heading
// kept short and the artwork hidden, so the form is in view straight away.
// Nothing has a fixed height: the page scrolls normally when the on-screen
// keyboard takes space.
export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main className="flex flex-1 flex-col sm:justify-center">
      <div className="mx-auto grid w-full max-w-[1320px] items-center gap-8 px-4 py-6 sm:gap-10 sm:px-6 sm:py-14 lg:grid-cols-[minmax(0,1fr)_minmax(440px,500px)] lg:gap-16 lg:px-10 lg:py-16 xl:gap-24">
        <div className="animate-enter mx-auto w-full max-w-[500px] lg:mx-0 lg:max-w-none">
          <div className="flex items-center gap-3">
            <BrandMark size="large" />
            <span className="text-base font-semibold tracking-tight text-navy sm:text-lg">Editorial Proposal Portal</span>
          </div>
          <h1 className="mt-6 text-balance text-[1.875rem] font-semibold leading-[1.1] tracking-tight text-navy sm:mt-8 sm:text-[2.5rem] lg:text-[3.25rem] xl:text-[3.5rem]">
            Clients and proposals, <span className="text-accent">in one place.</span>
          </h1>
          <p className="mt-4 hidden max-w-xl text-lg leading-8 text-muted sm:block lg:mt-5">
            Keep client records, prepare proposal PDFs with a free preview, and share each one through its own
            private link.
          </p>
          <LoginArt className="mt-10 hidden lg:block xl:mt-12" />
        </div>

        <div className="animate-enter mx-auto w-full max-w-[500px] [--enter-delay:90ms] lg:mx-0">
          <div className="rounded-2xl border border-border bg-surface p-6 shadow-panel sm:p-10">
            <header className="space-y-2">
              <h2 className="text-[1.75rem] font-semibold leading-tight tracking-tight text-navy sm:text-[2.25rem]">
                Welcome back
              </h2>
              <p className="text-base text-muted">Sign in with the account your administrator gave you.</p>
            </header>

            <div className="mt-7 sm:mt-8">
              <Suspense fallback={<LoginFormFallback />}>
                <LoginGate searchParams={searchParams} />
              </Suspense>
            </div>
          </div>

          <p className="mt-5 text-center text-sm text-subtle">
            Accounts are created by your administrator. There is no self sign-up.
          </p>
        </div>
      </div>
    </main>
  );
}

async function LoginGate({
  searchParams,
}: {
  searchParams: PageProps<"/login">["searchParams"];
}) {
  const params = await searchParams;
  const next = getSafeRedirectPath(firstValue(params.next));

  if (!isSupabaseConfigured()) {
    return (
      <p role="alert" className={calloutStyles.warning}>
        Sign-in isn&apos;t set up yet. Contact your administrator.
      </p>
    );
  }

  const auth = await getAuthState();

  if (auth.status === "authorized") {
    redirect(next);
  }

  // An outage is not "signed out": nothing about the session is changed,
  // and the form stays usable (it reports connection problems itself).
  if (auth.status === "unavailable") {
    return <LoginForm next={next} notice={UNAVAILABLE_NOTICE} noticeKind="connection" />;
  }

  const notice =
    auth.status === "unauthorized" || firstValue(params.error) === "no_access"
      ? NO_ACCESS_NOTICE
      : undefined;

  return <LoginForm next={next} notice={notice} />;
}

// Same size as the form it stands in for, so nothing shifts when it loads.
function LoginFormFallback() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="space-y-2">
        <div className={`${skeletonStyles} h-6 w-12`} />
        <div className={`${skeletonStyles} h-14`} />
      </div>
      <div className="space-y-2">
        <div className={`${skeletonStyles} h-6 w-20`} />
        <div className={`${skeletonStyles} h-14`} />
      </div>
      <div className={`${skeletonStyles} h-14`} />
    </div>
  );
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
