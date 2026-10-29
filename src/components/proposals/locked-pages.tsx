"use client";

import { ChevronLeft, ChevronRight, Lock } from "lucide-react";
import { useId, useState } from "react";

// Placeholders for the pages after the free preview. They are SYNTHETIC:
// built only from the page counts the page already shows, with a fixed,
// neutral pattern of grey bars. Nothing here fetches, renders or derives
// anything from the locked pages (the served preview PDF doesn't contain
// them), so no locked text or imagery can reach the browser.
//
// Shown a few at a time, so even a 300-page document renders at most
// PER_VIEW cards.

const PER_VIEW = 6;

// Line widths (%) of the decorative pattern, cycled per card so the cards
// don't look identical. Fixed values: unrelated to any document.
const LINE_WIDTHS = [92, 84, 96, 71, 88, 63, 94, 79, 86, 58, 90, 75];

export function LockedPagePlaceholders({
  freePages,
  totalPages,
  unlockable = false,
}: {
  freePages: number;
  totalPages: number;
  // Online payment is available for this proposal.
  unlockable?: boolean;
}) {
  const lockedPages = totalPages - freePages;
  const viewCount = Math.max(1, Math.ceil(lockedPages / PER_VIEW));
  const [view, setView] = useState(0);
  const headingId = useId();

  if (lockedPages <= 0) return null;

  const current = Math.min(view, viewCount - 1);
  const first = freePages + 1 + current * PER_VIEW;
  const last = Math.min(first + PER_VIEW - 1, totalPages);
  const pages = Array.from({ length: last - first + 1 }, (_, i) => first + i);

  const step =
    "inline-flex h-10 items-center justify-center gap-1.5 rounded-md border border-border-strong bg-surface px-3 text-sm font-medium text-foreground shadow-card " +
    "transition-colors hover:border-accent-border hover:bg-accent-soft hover:text-accent-strong " +
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
    "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border-strong disabled:hover:bg-surface disabled:hover:text-foreground";

  return (
    <section aria-labelledby={headingId} className="space-y-4" data-locked-pages>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h2 id={headingId} className="text-base font-semibold text-foreground">
            Locked pages
          </h2>
          <p className="text-sm text-muted" aria-live="polite" data-locked-range>
            Document pages {first}
            {last > first ? `–${last}` : ""} of {totalPages}
            {viewCount > 1 ? ` (${lockedPages} locked in total)` : ""}
          </p>
        </div>
        {viewCount > 1 ? (
          <div className="flex items-center gap-2" role="group" aria-label="Locked page navigation">
            <button
              type="button"
              className={step}
              onClick={() => setView(current - 1)}
              disabled={current === 0}
              aria-label="Previous locked pages"
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
              Previous
            </button>
            <button
              type="button"
              className={step}
              onClick={() => setView(current + 1)}
              disabled={current >= viewCount - 1}
              aria-label="Next locked pages"
            >
              Next
              <ChevronRight className="size-4" aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>

      <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
        {pages.map((page) => (
          <li key={page} data-locked-page={page}>
            <LockedPageCard page={page} totalPages={totalPages} unlockable={unlockable} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function LockedPageCard({ page, totalPages, unlockable }: { page: number; totalPages: number; unlockable: boolean }) {
  const offset = page % LINE_WIDTHS.length;
  return (
    <div
      role="group"
      aria-label={`Document page ${page} of ${totalPages}, locked`}
      className="relative flex aspect-[1/1.294] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-card"
    >
      <p className="z-10 border-b border-border bg-surface px-3 py-1.5 text-xs font-medium tabular-nums text-muted">
        Page {page} <span className="text-subtle">of {totalPages}</span>
      </p>

      {/* Decorative, content-free pattern (identical for every document). */}
      <div className="flex flex-1 flex-col gap-2 px-4 py-4 blur-[3px] select-none" aria-hidden="true">
        <div className="mb-1 h-3 w-1/2 rounded-sm bg-slate-300" />
        {Array.from({ length: 18 }, (_, i) => (
          <div
            key={i}
            className="h-2 rounded-sm bg-slate-200"
            style={{ width: `${LINE_WIDTHS[(offset + i) % LINE_WIDTHS.length]}%` }}
          />
        ))}
      </div>

      <div className="absolute inset-x-0 bottom-0 top-8 flex flex-col items-center justify-center gap-2 bg-surface/40 px-3 text-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-accent text-accent-foreground shadow-accent sm:size-12">
          <Lock className="size-5" aria-hidden="true" />
        </span>
        <p className="text-sm font-semibold text-foreground">Locked page</p>
        <p className="max-w-[16ch] text-xs leading-snug text-muted">
          {unlockable ? "Unlocks after payment." : <>Full access isn&apos;t available yet.</>}
        </p>
      </div>
    </div>
  );
}
