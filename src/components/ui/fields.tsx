import { AlertCircle, ChevronDown } from "lucide-react";
import { useId, type ReactNode } from "react";

import { errorTextStyles, hintStyles, inputStyles, labelStyles, selectStyles } from "./styles";

type BaseFieldProps = {
  label: string;
  name: string;
  defaultValue?: string;
  error?: string;
  hint?: string;
  required?: boolean;
};

export function FieldLabel({
  htmlFor,
  required,
  children,
}: {
  htmlFor: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className={labelStyles}>
      {children}
      {required ? <span className="font-normal text-subtle"> (required)</span> : null}
    </label>
  );
}

export function FieldMessages({
  hintId,
  errorId,
  hint,
  error,
}: {
  hintId: string;
  errorId: string;
  hint?: ReactNode;
  error?: string;
}) {
  return (
    <>
      {hint ? (
        <p id={hintId} className={hintStyles}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className={errorTextStyles}>
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </>
  );
}

export function describedBy(ids: (string | false | undefined | null)[]): string | undefined {
  const value = ids.filter(Boolean).join(" ");
  return value || undefined;
}

// Wraps a native <select> and draws a consistent chevron.
export function SelectChevron({ children }: { children: ReactNode }) {
  return (
    <div className="relative">
      {children}
      <ChevronDown
        className="pointer-events-none absolute right-4 top-1/2 size-4 -translate-y-1/2 text-subtle"
        aria-hidden="true"
      />
    </div>
  );
}

export function TextField({
  label,
  name,
  defaultValue,
  error,
  hint,
  required,
  type = "text",
  maxLength,
  autoComplete,
}: BaseFieldProps & {
  type?: "text" | "email";
  maxLength?: number;
  autoComplete?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <div className="space-y-2">
      <FieldLabel htmlFor={id} required={required}>
        {label}
      </FieldLabel>
      <input
        id={id}
        name={name}
        type={type}
        defaultValue={defaultValue}
        required={required}
        maxLength={maxLength}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy([hint && hintId, error && errorId])}
        className={inputStyles}
      />
      <FieldMessages hintId={hintId} errorId={errorId} hint={hint} error={error} />
    </div>
  );
}

export function SelectField({
  label,
  name,
  defaultValue,
  error,
  hint,
  required,
  placeholder,
  options,
}: BaseFieldProps & {
  placeholder: string;
  options: { value: string; label: string }[];
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <div className="space-y-2">
      <FieldLabel htmlFor={id} required={required}>
        {label}
      </FieldLabel>
      <SelectChevron>
        <select
          id={id}
          name={name}
          defaultValue={defaultValue ?? ""}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy([hint && hintId, error && errorId])}
          className={selectStyles}
        >
          <option value="">{placeholder}</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </SelectChevron>
      <FieldMessages hintId={hintId} errorId={errorId} hint={hint} error={error} />
    </div>
  );
}
