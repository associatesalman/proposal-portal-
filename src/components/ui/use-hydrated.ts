"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

// False in the server HTML and during hydration, true once this component
// is interactive. Controls that only work with JavaScript (dialog triggers,
// the password toggle) render disabled until then, so an early click is never
// silently lost.
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
