import { AlertTriangle, Inbox, SearchX } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { buttonStyles } from "@/components/ui/styles";

function StatePanel({
  icon,
  tone = "neutral",
  title,
  children,
}: {
  icon: ReactNode;
  tone?: "neutral" | "danger";
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-4 border-t border-border px-4 py-14 text-center sm:py-16">
      <span
        className={`flex size-14 items-center justify-center rounded-2xl ${
          tone === "danger" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent"
        }`}
      >
        {icon}
      </span>
      <div className="space-y-1.5">
        <p className="text-lg font-semibold text-navy">{title}</p>
        {children ? <div className="text-[15px] text-muted">{children}</div> : null}
      </div>
    </div>
  );
}

export function NoRecords({ title, hint }: { title: string; hint: string }) {
  return (
    <StatePanel icon={<Inbox className="size-6" aria-hidden="true" />} title={title}>
      {hint}
    </StatePanel>
  );
}

export function NoResults({ query, clearHref }: { query: string; clearHref: string }) {
  return (
    <StatePanel icon={<SearchX className="size-6" aria-hidden="true" />} title="No search results">
      <p>
        Nothing matches “<span className="break-all">{query}</span>”.
      </p>
      <Link href={clearHref} className={`${buttonStyles.secondary} mt-3`}>
        Clear search
      </Link>
    </StatePanel>
  );
}

export function PastLastPage({ firstPageHref }: { firstPageHref: string }) {
  return (
    <StatePanel icon={<Inbox className="size-6" aria-hidden="true" />} title="No records on this page">
      <Link href={firstPageHref} className={`${buttonStyles.secondary} mt-3`}>
        Go to the first page
      </Link>
    </StatePanel>
  );
}

export function LoadError({ what }: { what: string }) {
  return (
    <div role="alert">
      <StatePanel
        icon={<AlertTriangle className="size-6" aria-hidden="true" />}
        tone="danger"
        title={`We couldn't load ${what} right now.`}
      >
        Refresh the page to try again.
      </StatePanel>
    </div>
  );
}
