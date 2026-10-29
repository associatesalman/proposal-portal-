import Link from "next/link";

import { LinkPending } from "@/components/ui/link-pending";
import { focusRing } from "@/components/ui/styles";
import { dashboardHref, type DashboardTab } from "@/lib/dashboard/params";
import { formatCount } from "@/lib/format";

const TABS: { id: DashboardTab; label: string; shortLabel?: string }[] = [
  { id: "clients", label: "Clients" },
  { id: "proposals", label: "Proposals" },
  { id: "history", label: "Proposal History", shortLabel: "History" },
  { id: "payments", label: "Payments" },
];

// Section switcher implemented as links so every view has its own URL.
// Below 400 px the tabs are tighter so all four and the toolbar action stay
// on one row.
// Switching keeps the owner filter but resets search and pagination. The
// counts are the overall totals shown in the summary cards.
export function DashboardTabs({
  active,
  owner,
  counts,
}: {
  active: DashboardTab;
  owner: string | null;
  counts: Record<DashboardTab, number> | null;
}) {
  return (
    <nav aria-label="Dashboard sections" className="-mb-px">
      <ul className="flex gap-0.5 min-[400px]:gap-1">
        {TABS.map((tab) => {
          const isActive = tab.id === active;
          return (
            <li key={tab.id}>
              <Link
                href={dashboardHref({ tab: tab.id, owner })}
                aria-current={isActive ? "page" : undefined}
                className={`relative inline-flex h-14 items-center gap-2.5 rounded-t-lg px-1.5 text-[14px] font-semibold transition-colors duration-150 min-[400px]:px-2.5 min-[400px]:text-[15px] sm:h-16 sm:px-4 sm:text-[17px] ${focusRing} focus-visible:-outline-offset-2 after:absolute after:inset-x-1 min-[400px]:after:inset-x-2 sm:after:inset-x-3 after:-bottom-px after:h-[3px] after:rounded-full after:transition-colors after:duration-150 ${
                  isActive
                    ? "text-accent after:bg-accent"
                    : "text-muted after:bg-transparent hover:text-foreground hover:after:bg-border-strong"
                }`}
              >
                {tab.shortLabel ? (
                  <>
                    <span className="max-sm:hidden">{tab.label}</span>
                    <span className="sm:hidden" aria-hidden="true">
                      {tab.shortLabel}
                    </span>
                    <span className="sr-only sm:hidden">{tab.label}</span>
                  </>
                ) : (
                  tab.label
                )}
                {counts ? (
                  <span
                    className={`hidden h-6 min-w-7 items-center sm:inline-flex justify-center rounded-full px-2 text-[13px] font-medium tabular-nums transition-colors duration-150 ${
                      isActive ? "bg-accent-soft text-accent-strong" : "bg-surface-sunken text-muted"
                    }`}
                  >
                    <LinkPending>
                      <span className="sr-only">(</span>
                      {formatCount(counts[tab.id])}
                      <span className="sr-only"> total)</span>
                    </LinkPending>
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
