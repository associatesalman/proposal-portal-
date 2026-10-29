import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";

import { LinkPending } from "@/components/ui/link-pending";
import { buttonStyles } from "@/components/ui/styles";
import { dashboardHref, PAGE_SIZE, type DashboardParams } from "@/lib/dashboard/params";
import { formatCount } from "@/lib/format";

// Previous/Next keep their place when unavailable (shown disabled), so the
// controls don't jump around between pages.
export function Pagination({
  params,
  total,
  pageCount,
  noun,
}: {
  params: DashboardParams;
  total: number;
  pageCount: number;
  noun: string;
}) {
  if (total === 0) return null;

  const first = Math.min((params.page - 1) * PAGE_SIZE + 1, total);
  const last = Math.min(params.page * PAGE_SIZE, total);
  const hasPrevious = params.page > 1;
  const hasNext = params.page < pageCount;
  const step = buttonStyles.secondaryCompact;
  const disabledStep = `${step} pointer-events-none opacity-50 shadow-none`;

  return (
    <nav
      aria-label={`${noun} pagination`}
      className="flex flex-col gap-3 border-t border-border px-4 py-4 text-[15px] text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6"
    >
      <p>
        {params.page > pageCount
          ? `Page ${params.page} is past the end of ${formatCount(total)} ${noun}.`
          : `Showing ${formatCount(first)}–${formatCount(last)} of ${formatCount(total)} ${noun}`}
      </p>
      {pageCount > 1 ? (
        <div className="flex items-center justify-between gap-2 sm:justify-end">
          {hasPrevious ? (
            <Link
              href={dashboardHref({ ...params, page: Math.min(params.page - 1, pageCount) })}
              className={step}
              rel="prev"
            >
              <LinkPending>
                <ChevronLeft aria-hidden="true" />
              </LinkPending>
              Previous
            </Link>
          ) : (
            <span className={disabledStep} aria-hidden="true">
              <ChevronLeft aria-hidden="true" />
              Previous
            </span>
          )}
          <span aria-current="page" className="px-1 tabular-nums">
            Page {formatCount(Math.min(params.page, pageCount))} of {formatCount(pageCount)}
          </span>
          {hasNext ? (
            <Link href={dashboardHref({ ...params, page: params.page + 1 })} className={step} rel="next">
              Next
              <LinkPending>
                <ChevronRight aria-hidden="true" />
              </LinkPending>
            </Link>
          ) : (
            <span className={disabledStep} aria-hidden="true">
              Next
              <ChevronRight aria-hidden="true" />
            </span>
          )}
        </div>
      ) : null}
    </nav>
  );
}
