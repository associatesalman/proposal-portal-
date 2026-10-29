"use client";

import { Loader2, LogOut } from "lucide-react";
import { useFormStatus } from "react-dom";

import { buttonStyles } from "@/components/ui/styles";
import { signOut } from "@/lib/auth/actions";

// A plain form bound to a server action. The server HTML already contains a
// working POST form (React's progressive enhancement), so Sign out works as
// soon as the button is visible, before or after hydration; once hydrated it
// also shows a pending state.
export function SignOutButton() {
  return (
    <form action={signOut} data-sign-out>
      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending} className={buttonStyles.secondaryCompact}>
      {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <LogOut aria-hidden="true" />}
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
