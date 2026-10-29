// Shared class names for the design system (white surfaces, slate text, navy
// headings, one blue accent). Colours come from the tokens in
// src/app/globals.css.

export const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

// Heights are part of each variant (never overridden with another h-*
// class, which could lose to a responsive one): pick a variant instead.
const buttonBase =
  "inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium " +
  "transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.98] " +
  `${focusRing} disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0`;

const large = "h-11 px-4 text-[15px] sm:h-12 sm:px-5";
const compact = "h-10 px-3.5 text-sm";

// Main actions are 44 px on phones and 48 px from 640 px up; compact
// buttons (header, pagination, inline refresh) are 40 px.
export const buttonStyles = {
  primary: `${buttonBase} ${large} bg-accent text-accent-foreground shadow-card hover:bg-accent-hover hover:shadow-accent`,
  // The full-width sign-in button (56 px).
  primaryLarge: `${buttonBase} h-14 px-6 text-base bg-accent text-accent-foreground shadow-accent hover:bg-accent-hover`,
  secondary: `${buttonBase} ${large} border border-border-strong bg-surface text-foreground shadow-card hover:border-accent-border hover:bg-accent-soft/60 hover:text-accent-strong`,
  secondaryCompact: `${buttonBase} ${compact} border border-border-strong bg-surface text-foreground shadow-card hover:border-accent-border hover:bg-accent-soft/60 hover:text-accent-strong`,
  subtle: `${buttonBase} h-11 px-4 text-[15px] sm:h-12 text-muted hover:bg-surface-sunken hover:text-foreground`,
  destructive: `${buttonBase} ${large} bg-danger text-white shadow-card hover:bg-danger-hover`,
  // Action buttons inside table rows.
  rowAction: `${buttonBase} h-10 min-w-10 border border-transparent px-3 text-sm text-muted hover:border-accent-border hover:bg-accent-soft hover:text-accent-strong`,
  icon: `${buttonBase} size-10 text-subtle hover:bg-surface-sunken hover:text-foreground`,
} as const;

export type ButtonVariant = keyof typeof buttonStyles;

// Input look without a height or text size, for controls that set their own
// (the file picker, the monospace link field).
export const controlStyles =
  "block w-full rounded-lg border border-border-strong bg-surface text-foreground shadow-card " +
  "transition-[border-color,box-shadow,background-color] duration-150 ease-out placeholder:text-subtle " +
  "hover:border-slate-400 focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent/15 " +
  "aria-[invalid=true]:border-danger aria-[invalid=true]:focus:ring-danger/15 " +
  "disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-subtle";

// 48 px fields with 16 px text (which also stops iOS zooming in on focus).
export const inputStyles = `${controlStyles} h-12 px-4 text-base`;
// 56 px fields for the sign-in form.
export const inputLargeStyles = `${controlStyles} h-14 px-4 text-base`;

// Native select with room for a custom chevron (see SelectChevron in fields.tsx).
export const selectStyles = `${controlStyles} h-12 appearance-none pl-4 pr-10 text-base`;

export const labelStyles = "block text-[15px] font-medium text-foreground";
export const hintStyles = "text-sm leading-6 text-subtle";
export const errorTextStyles = "flex items-start gap-1.5 text-sm text-danger";

export const cardStyles = "rounded-xl border border-border bg-surface shadow-card";
// Larger dashboard panels (summary cards, the records panel).
export const panelStyles = "rounded-2xl border border-border bg-surface shadow-card";

// Headings shared by pages and dialogs.
export const pageTitleStyles =
  "text-[clamp(2rem,1.45rem+1.9vw,3rem)] font-semibold leading-[1.1] tracking-tight text-navy";
export const sectionTitleStyles = "text-xl font-semibold tracking-tight text-navy sm:text-2xl lg:text-[1.75rem]";

// Inline messages (form-level errors, notices).
const calloutBase = "rounded-lg border px-4 py-3 text-sm leading-6";
export const calloutStyles = {
  error: `${calloutBase} border-danger-border bg-danger-soft text-danger`,
  success: `${calloutBase} border-success-border bg-success-soft text-success`,
  warning: `${calloutBase} border-warning-border bg-warning-soft text-warning`,
  info: `${calloutBase} border-accent-border bg-accent-soft text-accent-strong`,
  neutral: `${calloutBase} border-border bg-surface-muted text-muted`,
} as const;

const badgeBase =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[13px] font-medium leading-5";

export const badgeStyles = {
  neutral: `${badgeBase} border-border bg-surface-muted text-muted`,
  accent: `${badgeBase} border-accent-border bg-accent-soft text-accent-strong`,
  success: `${badgeBase} border-success-border bg-success-soft text-success`,
  warning: `${badgeBase} border-warning-border bg-warning-soft text-warning`,
  danger: `${badgeBase} border-danger-border bg-danger-soft text-danger`,
  outline: `${badgeBase} border-dashed border-border-strong bg-surface text-subtle`,
} as const;

// Static placeholder blocks shown while content loads (no pulsing).
export const skeletonStyles = "rounded-md bg-surface-sunken";
