export type LoginFieldErrors = {
  email?: string;
  password?: string;
};

export type LoginState =
  | { status: "idle" }
  | {
      status: "error";
      // "connection": the sign-in service (or this server) couldn't be reached.
      // "rate_limited": too many attempts; retryAfterSeconds says how long.
      kind?: "connection" | "rate_limited";
      retryAfterSeconds?: number;
      message: string;
      fieldErrors?: LoginFieldErrors;
      email?: string;
    };

export const initialLoginState: LoginState = { status: "idle" };

export const CONNECTION_ERROR = "Can't connect to the sign-in service right now. Check your connection and try again.";
