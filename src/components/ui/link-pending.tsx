"use client";

import { Loader2 } from "lucide-react";
import { useLinkStatus } from "next/link";
import type { ReactNode } from "react";

// Inside a <Link>: shows a small spinner in place of `children` while that
// link's navigation is pending. Same size either way, so nothing shifts.
export function LinkPending({ children }: { children?: ReactNode }) {
  const { pending } = useLinkStatus();
  if (!pending) return <>{children}</>;
  return (
    <span className="inline-flex size-4 items-center justify-center" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      <span className="sr-only">Loading…</span>
    </span>
  );
}
