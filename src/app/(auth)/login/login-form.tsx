"use client";

import { AlertCircle, Eye, EyeOff, Loader2, WifiOff } from "lucide-react";
import { useActionState, useState } from "react";

import { describedBy, FieldLabel, FieldMessages } from "@/components/ui/fields";
import { buttonStyles, calloutStyles, inputLargeStyles } from "@/components/ui/styles";
import { useHydrated } from "@/components/ui/use-hydrated";

import { login } from "./actions";
import { CONNECTION_ERROR, initialLoginState, type LoginState } from "./state";

type LoginFormProps = {
  next: string;
  notice?: string;
  // "connection": the notice is about the service being unreachable.
  noticeKind?: "connection";
};

// Once interactive, a request that never reaches the server (offline, server
// down) shows a connection message instead of an error page. Other errors,
// including Next's redirect after a successful sign-in, pass through.
async function loginOrConnectionError(previous: LoginState, formData: FormData): Promise<LoginState> {
  try {
    return await login(previous, formData);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const email = formData.get("email");
    return {
      status: "error",
      kind: "connection",
      message: CONNECTION_ERROR,
      email: typeof email === "string" ? email : undefined,
    };
  }
}

// Works before hydration too: the server HTML posts to the server action
// natively.
export function LoginForm({ next, notice, noticeKind }: LoginFormProps) {
  const hydrated = useHydrated();
  const [state, formAction, pending] = useActionState(hydrated ? loginOrConnectionError : login, initialLoginState);
  const [showPassword, setShowPassword] = useState(false);

  const fieldErrors = state.status === "error" ? state.fieldErrors : undefined;
  const message = state.status === "error" ? state.message : notice;
  const isConnection = state.status === "error" ? state.kind === "connection" : noticeKind === "connection";
  const MessageIcon = isConnection ? WifiOff : AlertCircle;

  return (
    <form action={formAction} aria-describedby="login-message" aria-busy={pending || undefined}>
      <input type="hidden" name="next" value={next} />

      {/* Always in the page (so it is announced); it only takes space when
          it has a message. */}
      <div id="login-message" role="alert" aria-live="polite" className="[&:not(:empty)]:mb-6">
        {message ? (
          <p
            className={`${isConnection ? calloutStyles.warning : calloutStyles.error} animate-fade-in flex items-start gap-2.5 text-[15px]`}
          >
            <MessageIcon className="mt-1 size-4 shrink-0" aria-hidden="true" />
            <span>{message}</span>
          </p>
        ) : null}
      </div>

      <div className="space-y-6">
        <div className="space-y-2">
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            inputMode="email"
            required
            maxLength={320}
            placeholder="name@company.com"
            defaultValue={state.status === "error" ? state.email : undefined}
            readOnly={pending}
            aria-invalid={fieldErrors?.email ? true : undefined}
            aria-describedby={describedBy([fieldErrors?.email && "email-error"])}
            className={inputLargeStyles}
          />
          <FieldMessages hintId="email-hint" errorId="email-error" error={fieldErrors?.email} />
        </div>

        <div className="space-y-2">
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <div className="relative">
            <input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              required
              maxLength={1024}
              readOnly={pending}
              aria-invalid={fieldErrors?.password ? true : undefined}
              aria-describedby={describedBy([fieldErrors?.password && "password-error"])}
              className={`${inputLargeStyles} pr-14`}
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              disabled={!hydrated}
              aria-label="Show password"
              aria-pressed={showPassword}
              aria-controls="password"
              data-password-toggle
              className={`${buttonStyles.icon} absolute inset-y-0 right-2 my-auto [&_svg]:size-5`}
            >
              {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </button>
          </div>
          <FieldMessages hintId="password-hint" errorId="password-error" error={fieldErrors?.password} />
        </div>

        <button type="submit" disabled={pending} className={`${buttonStyles.primaryLarge} w-full`}>
          {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </form>
  );
}
