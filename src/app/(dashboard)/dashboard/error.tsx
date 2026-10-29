"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";

import { buttonStyles } from "@/components/ui/styles";

// Shown for unexpected failures while rendering the dashboard. Details are
// logged on the server; nothing internal is shown here.
export default function DashboardError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center">
      <AlertTriangle className="size-8 text-danger" aria-hidden="true" />
      <div role="alert" className="space-y-1">
        <h1 className="text-lg font-semibold">The dashboard couldn&apos;t be loaded</h1>
        <p className="text-sm text-muted">Something went wrong on our side. Try again in a moment.</p>
      </div>
      <button type="button" onClick={reset} className={buttonStyles.secondary}>
        <RotateCcw className="size-4" aria-hidden="true" />
        Try again
      </button>
    </main>
  );
}
