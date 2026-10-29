export type FormValues = Record<string, string>;

export type FormState =
  | { status: "idle" }
  | { status: "success"; message: string; submissionId: string }
  | {
      status: "error";
      message: string;
      fieldErrors?: Record<string, string | undefined>;
      values: FormValues;
    };

export const initialFormState: FormState = { status: "idle" };
