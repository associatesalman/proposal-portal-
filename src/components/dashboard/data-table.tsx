import type { ReactNode } from "react";

// A real <table> on medium screens and up; below that each row becomes a
// stacked record (actions always visible, never hover-only) and every cell
// shows its column label (from data-label). Sits full-width inside the
// records panel and scrolls inside its own box rather than widening the page.

export function DataTable({
  caption,
  columns,
  children,
}: {
  caption: string;
  columns: { label: string; className?: string; srOnly?: boolean }[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto border-t border-border">
      <table className="w-full text-left text-[15px] max-md:block">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-border bg-surface-muted text-[13px] text-subtle max-md:sr-only">
          <tr>
            {columns.map((column) => (
              <th
                key={column.label}
                scope="col"
                className={`whitespace-nowrap px-4 py-3.5 font-medium first:pl-6 last:pr-6 ${column.className ?? ""}`}
              >
                {column.srOnly ? <span className="sr-only">{column.label}</span> : column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border max-md:block">{children}</tbody>
      </table>
    </div>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return (
    <tr className="transition-colors duration-150 max-md:grid max-md:gap-2 max-md:px-4 max-md:py-5 md:hover:bg-accent-soft/40">
      {children}
    </tr>
  );
}

export function Cell({
  label,
  children,
  className,
  primary,
  actions,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  primary?: boolean;
  actions?: boolean;
}) {
  return (
    <td
      data-label={label}
      className={
        "px-4 py-4 align-middle max-md:px-0 md:h-[72px] md:first:pl-6 md:last:pr-6 max-md:py-0 " +
        (primary
          ? "font-semibold text-navy max-md:mb-1 max-md:text-[17px] md:text-base "
          : actions
            ? "max-md:mt-2 max-md:border-t max-md:border-border max-md:pt-3 "
            : "max-md:flex max-md:items-baseline max-md:justify-between max-md:gap-4 max-md:before:shrink-0 max-md:before:text-subtle max-md:before:content-[attr(data-label)] ") +
        (className ?? "")
      }
    >
      {children}
    </td>
  );
}
