"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Keeps the Payments tab current without a realtime service: re-renders the
// server page (router.refresh) at a fixed interval, only while the tab is
// visible, and stops after MAX_REFRESHES (about 10 minutes) or on unmount.
// Coming back to a hidden tab refreshes once and restarts the budget.

const INTERVAL_MS = 20_000;
const MAX_REFRESHES = 30;

export function PaymentsAutoRefresh() {
  const router = useRouter();

  useEffect(() => {
    let timer: number | undefined;
    let remaining = MAX_REFRESHES;

    const stop = () => {
      window.clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      stop();
      timer = window.setInterval(() => {
        if (document.visibilityState !== "visible" || remaining <= 0) return stop();
        remaining -= 1;
        router.refresh();
      }, INTERVAL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        remaining = MAX_REFRESHES;
        router.refresh();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router]);

  return null;
}
