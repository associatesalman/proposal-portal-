"use client";

import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { createContext, use, useCallback, useEffect, useState, type ReactNode } from "react";

type Tone = "success" | "error";
type Toast = { id: number; message: string; tone: Tone; leaving: boolean };
type Notify = (message: string, tone?: Tone) => void;

const FeedbackContext = createContext<Notify | null>(null);

const VISIBLE_MS = 6000;

// Toasts after dialog actions. The live region is always in the page, so
// screen readers announce each message politely. A toast stays while the
// pointer or keyboard focus is on it and fades out afterwards.
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const [paused, setPaused] = useState(false);

  const notify = useCallback<Notify>((message, tone = "success") => {
    setToast({ id: Date.now(), message, tone, leaving: false });
  }, []);

  const dismiss = useCallback(() => {
    setToast((current) => (current ? { ...current, leaving: true } : current));
  }, []);

  useEffect(() => {
    if (!toast || toast.leaving || paused) return;
    const timeout = window.setTimeout(dismiss, VISIBLE_MS);
    return () => window.clearTimeout(timeout);
  }, [toast, paused, dismiss]);

  const Icon = toast?.tone === "error" ? AlertCircle : CheckCircle2;

  return (
    <FeedbackContext value={notify}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4 sm:bottom-6 sm:justify-end sm:px-6"
      >
        {toast ? (
          <div
            key={toast.id}
            data-toast={toast.tone}
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
            onFocus={() => setPaused(true)}
            onBlur={() => setPaused(false)}
            onAnimationEnd={() => {
              if (toast.leaving) {
                setToast(null);
                setPaused(false);
              }
            }}
            className={`pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border bg-surface py-3.5 pl-4 pr-2.5 text-[15px] text-foreground shadow-overlay ${
              toast.tone === "error" ? "border-danger-border" : "border-border"
            } ${toast.leaving ? "animate-toast-out" : "animate-toast-in"}`}
          >
            <Icon
              className={`mt-0.5 size-5 shrink-0 ${toast.tone === "error" ? "text-danger" : "text-success"}`}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 break-words py-px">{toast.message}</span>
            <button
              type="button"
              onClick={dismiss}
              className="-my-1.5 inline-flex size-9 shrink-0 items-center justify-center rounded-md text-subtle transition-colors duration-150 hover:bg-surface-sunken hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              aria-label="Dismiss notification"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>
    </FeedbackContext>
  );
}

export function useFeedback(): Notify {
  const notify = use(FeedbackContext);
  return notify ?? (() => {});
}
