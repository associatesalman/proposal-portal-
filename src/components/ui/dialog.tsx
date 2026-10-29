"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

import { buttonStyles } from "./styles";

type DialogProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  size?: "default" | "wide";
  // While busy (a request is running) Escape and the close button are
  // disabled, so the result of the request is never lost.
  busy?: boolean;
  // Called once the closing fade has finished (or at once without motion),
  // e.g. to unmount content that should not linger in the page.
  onExited?: () => void;
  children: ReactNode;
};

// Exit fade (globals.css) is 200 ms; this is only a fallback in case no
// transitionend event arrives.
const EXIT_FALLBACK_MS = 320;

// Modal built on the native <dialog> element: showModal() makes the rest of
// the page inert (so focus stays inside), Escape closes it, and focus returns
// to the element that opened it. Clicking the backdrop does not close it, so
// a stray click never discards what was typed. The body scrolls inside the
// dialog on small screens; the header with the close button stays visible.
export function Dialog({
  open,
  onClose,
  title,
  description,
  size = "default",
  busy = false,
  onExited,
  children,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onExitedRef = useRef(onExited);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    onExitedRef.current = onExited;
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      // Start on the first field rather than on the close button.
      const first = dialog.querySelector<HTMLElement>(
        "[data-autofocus], input:not([type=hidden]):not([disabled]):not([readonly]), select:not([disabled]), textarea:not([disabled])",
      );
      first?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // The native "close" event arrives a task after the dialog has closed, so
  // user-initiated closes (Escape, the close button) also report it at once:
  // otherwise a click on the trigger in between would find `open` still true
  // and be lost.
  function requestClose() {
    dialogRef.current?.close();
    onClose();
  }

  function handleClose() {
    // A late "close" event for a dialog that has already been reopened.
    if (dialogRef.current?.open) return;
    onClose();
    returnFocusRef.current?.focus();

    const dialog = dialogRef.current;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      dialog?.removeEventListener("transitionend", onTransitionEnd);
      window.clearTimeout(timer);
      onExitedRef.current?.();
    };
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === dialog && event.propertyName === "opacity") finish();
    };
    dialog?.addEventListener("transitionend", onTransitionEnd);
    const timer = window.setTimeout(finish, EXIT_FALLBACK_MS);
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      aria-busy={busy || undefined}
      // While busy, Escape must not close the dialog. closedby="none" stops it
      // in browsers that support the attribute; preventDefault on "cancel"
      // covers the rest.
      closedby={busy ? "none" : "closerequest"}
      onClose={handleClose}
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
      className={`ui-dialog m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-1.5rem)] sm:w-[calc(100%-3rem)] flex-col overflow-clip rounded-2xl open:flex border border-border bg-surface p-0 text-left text-foreground shadow-overlay ${
        size === "wide" ? "max-w-3xl" : "max-w-xl"
      }`}
    >
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-5 sm:px-8 sm:py-6">
        <div className="min-w-0 space-y-1.5">
          <h2 id={titleId} className="text-xl font-semibold tracking-tight text-navy sm:text-2xl">
            {title}
          </h2>
          {description ? (
            <div id={descriptionId} className="break-words text-[15px] leading-6 text-muted">
              {description}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={requestClose}
          disabled={busy}
          className={`${buttonStyles.icon} -mr-2 -mt-0.5`}
          aria-label="Close"
        >
          <X aria-hidden="true" />
        </button>
      </div>
      {/* Only the body scrolls. `relative` keeps absolutely positioned content
          (e.g. sr-only text) inside it, and the dialog is overflow-clip so focus
          changes can never scroll the dialog itself and hide the header. */}
      <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-6 sm:px-8 sm:py-7">{children}</div>
    </dialog>
  );
}
