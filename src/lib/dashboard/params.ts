import type { AppRole } from "@/types/database";

export const PAGE_SIZE = 10;
export const SEARCH_MAX_LENGTH = 100;

export type DashboardTab = "clients" | "proposals" | "history" | "payments";

// Proposal History filter. "deleting" means a permanent deletion was started
// but has not finished; the lifecycle values exclude those proposals.
export const HISTORY_STATUSES = ["all", "draft", "active", "archived", "deleting"] as const;
export type HistoryStatus = (typeof HISTORY_STATUSES)[number];

export const HISTORY_STATUS_LABELS: Record<HistoryStatus, string> = {
  all: "All statuses",
  draft: "Draft",
  active: "Active (link issued)",
  archived: "Archived",
  deleting: "Deletion pending",
};

// Payments tab filter (groups of payment states).
export const PAYMENT_FILTERS = ["all", "completed", "pending", "awaiting", "refunded", "unsuccessful", "review"] as const;
export type PaymentFilter = (typeof PAYMENT_FILTERS)[number];

export const PAYMENT_FILTER_LABELS: Record<PaymentFilter, string> = {
  all: "All payment states",
  completed: "Completed",
  pending: "Pending verification",
  awaiting: "Checkout not finished",
  refunded: "Refunded or reversed",
  unsuccessful: "Failed, denied or cancelled",
  review: "Needs review",
};

export type DashboardParams = {
  tab: DashboardTab;
  q: string;
  page: number;
  // Admin-only owner filter (a team lead's profile id); always null for leads.
  owner: string | null;
  // History tab only; "all" elsewhere.
  status: HistoryStatus;
  // Payments tab only; "all" elsewhere.
  paymentStatus: PaymentFilter;
};

type RawSearchParams = Record<string, string | string[] | undefined>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Removes control characters (so a term can never match across the newline
// separator in search_text) and collapses whitespace.
export function normalizeSearch(value: string | undefined): string {
  if (!value) return "";
  let cleaned = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    cleaned += code < 0x20 || code === 0x7f ? " " : char;
  }
  return cleaned.replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX_LENGTH);
}

export function parseDashboardParams(
  raw: RawSearchParams,
  role: AppRole,
): DashboardParams {
  const tabValue = first(raw.tab);
  const tab: DashboardTab =
    tabValue === "proposals" || tabValue === "history" || tabValue === "payments" ? tabValue : "clients";

  const statusValue = first(raw.status);
  const status: HistoryStatus =
    tab === "history" && HISTORY_STATUSES.includes(statusValue as HistoryStatus)
      ? (statusValue as HistoryStatus)
      : "all";
  const paymentStatus: PaymentFilter =
    tab === "payments" && PAYMENT_FILTERS.includes(statusValue as PaymentFilter)
      ? (statusValue as PaymentFilter)
      : "all";

  const pageNumber = Number.parseInt(first(raw.page) ?? "1", 10);
  const page = Number.isFinite(pageNumber) && pageNumber > 0 ? Math.min(pageNumber, 10_000) : 1;

  const ownerValue = first(raw.owner);
  const owner =
    role === "admin" && ownerValue && UUID_PATTERN.test(ownerValue)
      ? ownerValue.toLowerCase()
      : null;

  return { tab, q: normalizeSearch(first(raw.q)), page, owner, status, paymentStatus };
}

// Escapes LIKE wildcards so user input is matched literally. "*" is removed
// because PostgREST treats it as a wildcard in like/ilike filters.
export function toIlikePattern(term: string): string {
  const escaped = term.replace(/\*/g, "").replace(/[\\%_]/g, (match) => `\\${match}`);
  return `%${escaped}%`;
}

export function dashboardHref(params: Partial<DashboardParams>): string {
  const search = new URLSearchParams();
  if (params.tab && params.tab !== "clients") search.set("tab", params.tab);
  if (params.owner) search.set("owner", params.owner);
  if (params.tab === "history" && params.status && params.status !== "all") search.set("status", params.status);
  if (params.tab === "payments" && params.paymentStatus && params.paymentStatus !== "all") {
    search.set("status", params.paymentStatus);
  }
  if (params.q) search.set("q", params.q);
  if (params.page && params.page > 1) search.set("page", String(params.page));
  const query = search.toString();
  return query ? `/dashboard?${query}` : "/dashboard";
}
