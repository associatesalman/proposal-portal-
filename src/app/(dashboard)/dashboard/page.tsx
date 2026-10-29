import type { Metadata } from "next";
import { Suspense } from "react";

import { EditDisplayNameDialog } from "@/components/dashboard/account-dialogs";
import { AddClientDialog } from "@/components/dashboard/client-dialogs";
import { ClientsSection } from "@/components/dashboard/clients-section";
import { DashboardTabs } from "@/components/dashboard/dashboard-tabs";
import { FeedbackProvider } from "@/components/dashboard/feedback";
import { HistorySection } from "@/components/dashboard/history-section";
import { ListFilters } from "@/components/dashboard/list-filters";
import { PaymentsSection } from "@/components/dashboard/payments-section";
import { NewProposalDialog } from "@/components/dashboard/proposal-dialogs";
import { ProposalsSection } from "@/components/dashboard/proposals-section";
import { SignOutButton } from "@/components/dashboard/sign-out-button";
import { SummaryCards } from "@/components/dashboard/summary-cards";
import { BrandMark } from "@/components/ui/brand";
import { ServiceUnavailable } from "@/components/ui/service-unavailable";
import { calloutStyles, pageTitleStyles, panelStyles, skeletonStyles } from "@/components/ui/styles";
import { ROLE_LABELS } from "@/lib/auth/roles";
import { requireInternalUser } from "@/lib/auth/session";
import { parseDashboardParams } from "@/lib/dashboard/params";
import {
  getPaymentSummary,
  getSummaryCounts,
  listClientOptions,
  listClients,
  listPayments,
  listProposals,
  listTeamLeads,
} from "@/lib/dashboard/queries";
import { getPdfLimits } from "@/lib/proposals/limits";
import { createClient } from "@/lib/supabase/server";

// Server Actions on this page download, parse and split PDFs (see
// src/lib/proposals/limits.ts); allow them up to 60 seconds.
export const maxDuration = 60;

export const metadata: Metadata = {
  title: "Dashboard · Editorial Proposal Portal",
  robots: { index: false, follow: false },
};

// Shared by the page and its loading fallback so they line up exactly.
const container = "mx-auto w-full max-w-[1440px] px-4 sm:px-6 lg:px-10";

export default function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  return (
    <Suspense fallback={<DashboardFallback />}>
      <DashboardContent searchParams={searchParams} />
    </Suspense>
  );
}

async function DashboardContent({
  searchParams,
}: {
  searchParams: PageProps<"/dashboard">["searchParams"];
}) {
  // Verifies the session with Supabase Auth and requires an internal profile.
  const auth = await requireInternalUser();
  if (auth.status === "unavailable") {
    // Fail closed: no dashboard data is queried, and no redirect (which
    // could loop) or sign-out happens.
    return (
      <main className={`${container} flex flex-1 flex-col justify-center py-10`}>
        <ServiceUnavailable
          retryHref="/dashboard"
          message="We can't reach the portal's database or sign-in service right now. Your session and data haven't been changed. Try again in a moment."
        />
      </main>
    );
  }
  const { user } = auth;
  const isAdmin = user.role === "admin";
  const supabase = await createClient();

  const teamLeadsResult = await listTeamLeads(supabase, user);
  const teamLeads = teamLeadsResult.ok ? teamLeadsResult.data : [];

  const parsed = parseDashboardParams(await searchParams, user.role);
  // Admins may only filter by an existing team lead; anything else is ignored.
  const ownerLead = parsed.owner ? teamLeads.find((lead) => lead.id === parsed.owner) : undefined;
  const params = { ...parsed, owner: ownerLead ? ownerLead.id : null };

  const [summary, clientOptions, clients, proposals, payments, paymentSummary] = await Promise.all([
    getSummaryCounts(supabase, params.owner),
    listClientOptions(supabase),
    params.tab === "clients" ? listClients(supabase, params) : null,
    params.tab === "proposals" || params.tab === "history" ? listProposals(supabase, params) : null,
    params.tab === "payments" ? listPayments(supabase, params) : null,
    getPaymentSummary(supabase, params.owner),
  ]);

  const scopeLabel = !isAdmin
    ? "Your overall totals"
    : ownerLead
      ? `Overall totals for ${ownerLead.fullName}`
      : "Overall totals, all team leads";

  const tabCounts =
    summary.ok && paymentSummary.ok
      ? {
          clients: summary.data.clients,
          proposals: summary.data.proposals,
          history: summary.data.proposals,
          payments: paymentSummary.data.all,
        }
      : null;
  const noClients = clientOptions.ok && clientOptions.data.length === 0;

  return (
    <FeedbackProvider>
      <header className="sticky top-0 z-30 border-b border-border bg-surface">
        <div className={`${container} flex h-16 items-center justify-between gap-3 sm:h-[72px]`}>
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark size="large" />
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold tracking-tight text-navy sm:text-base">
                Editorial Proposal Portal
              </p>
              <p className="flex text-[13px] text-muted sm:hidden">
                <span className="truncate">{user.fullName}</span>
                <span className="shrink-0">&nbsp;· {ROLE_LABELS[user.role]}</span>
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-4">
            <div className="hidden min-w-0 items-center gap-3 sm:flex">
              <p className="max-w-64 truncate text-[15px] font-medium text-foreground">{user.fullName}</p>
              <span className="rounded-full border border-accent-border bg-accent-soft px-2.5 py-0.5 text-[13px] font-medium text-accent-strong">
                {ROLE_LABELS[user.role]}
              </span>
            </div>
            <EditDisplayNameDialog fullName={user.fullName} />
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className={`${container} flex-1 space-y-8 py-7 sm:py-9`}>
        <div className="animate-enter space-y-2 sm:space-y-3">
          <h1 className={pageTitleStyles}>Dashboard</h1>
          <p className="text-base text-muted sm:text-lg">
            {isAdmin
              ? "Clients and proposals across all team leads."
              : "Your clients, proposals and private links."}
          </p>
        </div>

        <SummaryCards counts={summary.ok ? summary.data : null} scopeLabel={scopeLabel} />

        {isAdmin && !teamLeadsResult.ok ? (
          <p role="alert" className={calloutStyles.error}>
            Team leads couldn&apos;t be loaded, so owner filtering and adding clients are unavailable.
          </p>
        ) : null}

        <section
          aria-labelledby="records-heading"
          className={`${panelStyles} animate-enter overflow-hidden [--enter-delay:180ms]`}
        >
          <h2 id="records-heading" className="sr-only">
            Records
          </h2>
          <div className="flex flex-wrap items-end justify-between gap-x-2 border-b border-border pl-1 pr-2 min-[400px]:gap-x-3 min-[400px]:pl-1.5 min-[400px]:pr-3 sm:pl-4 sm:pr-6">
            <DashboardTabs active={params.tab} owner={params.owner} counts={tabCounts} />
            <div className="py-3 sm:py-3.5">
              {params.tab === "payments" ? null : params.tab === "clients" ? (
                <AddClientDialog
                  isAdmin={isAdmin}
                  teamLeads={teamLeads}
                  defaultOwnerId={params.owner}
                />
              ) : (
                <NewProposalDialog
                  clients={clientOptions.ok ? clientOptions.data : []}
                  showOwners={isAdmin}
                />
              )}
            </div>
          </div>

          <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-5">
            <ListFilters
              tab={params.tab}
              q={params.q}
              owner={params.owner}
              status={params.status}
              paymentStatus={params.paymentStatus}
              teamLeads={teamLeads}
              isAdmin={isAdmin}
            />
            {params.tab === "history" ? (
              <p className={calloutStyles.neutral}>
                Private links are stored only as a fingerprint, so an earlier link can&apos;t be shown or recovered.
                To share a proposal again, open “Manage Document” and generate a new link: that permanently replaces the
                previous link, which stops working.
              </p>
            ) : null}
            {params.tab === "payments" ? (
              <p className={calloutStyles.neutral}>
                Payments are recorded only after PayPal confirms them to the server. Status updates appear here
                automatically while this page is open.
              </p>
            ) : null}
            {(params.tab === "proposals" || params.tab === "history") && noClients ? (
              <p className={calloutStyles.info}>Add a client on the Clients tab before creating a proposal.</p>
            ) : null}
          </div>

          {params.tab === "clients" ? (
            <ClientsSection
              result={clients && clients.ok ? clients.data : null}
              params={params}
              isAdmin={isAdmin}
            />
          ) : params.tab === "payments" ? (
            <PaymentsSection
              result={payments && payments.ok ? payments.data : null}
              summary={paymentSummary.ok ? paymentSummary.data : null}
              params={params}
              isAdmin={isAdmin}
            />
          ) : params.tab === "history" ? (
            <HistorySection
              result={proposals && proposals.ok ? proposals.data : null}
              params={params}
              isAdmin={isAdmin}
              pdfLimits={getPdfLimits()}
            />
          ) : (
            <ProposalsSection
              result={proposals && proposals.ok ? proposals.data : null}
              params={params}
              isAdmin={isAdmin}
              pdfLimits={getPdfLimits()}
            />
          )}
        </section>
      </main>
    </FeedbackProvider>
  );
}

// Same layout and sizes as the loaded page, so nothing shifts when it
// arrives. Static blocks (no pulsing); the status text is for screen readers.
function DashboardFallback() {
  const block = skeletonStyles;
  return (
    <div className="flex flex-1 flex-col" aria-busy="true">
      <p className="sr-only" role="status">
        Loading dashboard…
      </p>
      <div className="border-b border-border" aria-hidden="true">
        <div className={`${container} flex h-16 items-center justify-between sm:h-[72px]`}>
          <div className="flex items-center gap-3">
            <div className={`${block} size-10 rounded-xl`} />
            <div className={`${block} h-5 w-52`} />
          </div>
          <div className={`${block} h-10 w-28`} />
        </div>
      </div>
      <div className={`${container} space-y-8 py-7 sm:py-9`} aria-hidden="true">
        <div className="space-y-3">
          <div className={`${block} h-10 w-56 sm:h-12`} />
          <div className={`${block} h-6 w-80 max-w-full`} />
        </div>
        <div className="space-y-4">
          <div className={`${block} h-8 w-44`} />
          <div className="grid grid-cols-3 gap-3 sm:gap-5 lg:gap-6">
            {[0, 1, 2].map((i) => (
              <div key={i} className={`${panelStyles} h-[104px] p-4 sm:h-[168px] sm:p-7`}>
                <div className={`${block} h-4 w-full max-w-32 sm:h-12`} />
                <div className={`${block} mt-3 h-7 w-12 sm:mt-6 sm:h-12 sm:w-20`} />
              </div>
            ))}
          </div>
        </div>
        <div className={`${panelStyles} overflow-hidden`}>
          <div className="flex h-[69px] items-center justify-between border-b border-border px-4 sm:h-[77px] sm:px-6">
            <div className={`${block} h-6 w-52`} />
            <div className={`${block} h-11 w-36 sm:h-12`} />
          </div>
          <div className="px-4 py-4 sm:px-6 sm:py-5">
            <div className={`${block} h-12`} />
          </div>
          <div className="divide-y divide-border border-t border-border">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex h-[72px] items-center gap-4 px-6">
                <div className={`${block} h-5 w-1/4`} />
                <div className={`${block} h-5 w-1/4`} />
                <div className={`${block} h-5 w-16`} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
