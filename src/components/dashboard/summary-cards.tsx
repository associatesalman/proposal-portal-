import { FilePen, FileText, Users, type LucideIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { calloutStyles, panelStyles, sectionTitleStyles } from "@/components/ui/styles";
import type { SummaryCounts } from "@/lib/dashboard/queries";
import { formatCount } from "@/lib/format";

// Overall totals (not affected by search or paging). Only real counts are
// shown: no trends, revenue or charts. The cards are not interactive, so
// they have no hover state or pointer cursor.
export function SummaryCards({
  counts,
  scopeLabel,
}: {
  counts: SummaryCounts | null;
  scopeLabel: string;
}) {
  const items: { label: string; value: number | undefined; icon: LucideIcon }[] = [
    { label: "Total clients", value: counts?.clients, icon: Users },
    { label: "Total proposals", value: counts?.proposals, icon: FileText },
    { label: "Draft proposals", value: counts?.drafts, icon: FilePen },
  ];

  return (
    <section aria-labelledby="summary-heading" className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="summary-heading" className={sectionTitleStyles}>
          Overview
          <span className="sr-only">: {scopeLabel}</span>
        </h2>
        <p className="text-[15px] text-muted" aria-hidden="true">
          {scopeLabel}
        </p>
      </div>
      {counts === null ? (
        <p role="alert" className={calloutStyles.error}>
          Totals couldn&apos;t be loaded. Refresh the page to try again.
        </p>
      ) : null}
      <dl className="grid grid-cols-3 gap-3 sm:gap-5 lg:gap-6">
        {items.map(({ label, value, icon: Icon }, index) => (
          <div
            key={label}
            style={{ "--enter-delay": `${60 + index * 60}ms` } as CSSProperties}
            className={`${panelStyles} animate-enter relative flex min-h-[104px] flex-col justify-between overflow-hidden p-4 sm:min-h-[168px] sm:p-6 lg:p-7`}
          >
            {/* The icon comes first in the markup and is shown on the right. */}
            <dt className="flex flex-row-reverse items-start justify-between gap-3 text-[13px] font-medium leading-5 text-muted sm:text-base sm:leading-6">
              <span className="hidden size-12 shrink-0 items-center justify-center rounded-xl border border-accent-border/70 bg-accent-soft text-accent sm:flex lg:size-14">
                <Icon className="size-6" aria-hidden="true" />
              </span>
              {label}
            </dt>
            <dd className="mt-2 text-[1.75rem] font-semibold leading-none tracking-tight tabular-nums text-navy sm:mt-4 sm:text-[2.75rem] lg:text-[3.25rem]">
              {value === undefined ? "—" : formatCount(value)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
