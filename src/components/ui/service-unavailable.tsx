import { RotateCcw, WifiOff } from "lucide-react";

import { buttonStyles } from "@/components/ui/styles";

// Shown when Supabase can't be reached or doesn't answer in time. Nothing
// protected is loaded behind it, and nothing about the session changes: the
// retry is a plain full-page reload of the same address.
export function ServiceUnavailable({
  retryHref,
  title = "Service temporarily unavailable",
  message = "We can't reach the service right now. Nothing has been changed. Try again in a moment.",
  headingLevel = 1,
}: {
  retryHref: string;
  title?: string;
  message?: string;
  headingLevel?: 1 | 2;
}) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <div data-service-unavailable className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-warning-soft text-warning">
        <WifiOff className="size-6" aria-hidden="true" />
      </span>
      <div role="alert" className="space-y-1.5">
        <Heading className="text-xl font-semibold tracking-tight text-navy">{title}</Heading>
        <p className="text-base text-muted">{message}</p>
      </div>
      {/* A real navigation (not client routing) so every check runs again. */}
      <a href={retryHref} className={buttonStyles.secondary}>
        <RotateCcw className="size-4" aria-hidden="true" />
        Try again
      </a>
    </div>
  );
}
