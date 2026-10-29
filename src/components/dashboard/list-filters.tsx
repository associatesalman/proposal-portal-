"use client";

import { Loader2, Search, X } from "lucide-react";
import Form from "next/form";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { flushSync, useFormStatus } from "react-dom";

import { SelectChevron } from "@/components/ui/fields";
import { buttonStyles, inputStyles, selectStyles } from "@/components/ui/styles";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  dashboardHref,
  HISTORY_STATUS_LABELS,
  HISTORY_STATUSES,
  PAYMENT_FILTER_LABELS,
  PAYMENT_FILTERS,
  SEARCH_MAX_LENGTH,
  type DashboardTab,
  type HistoryStatus,
  type PaymentFilter,
} from "@/lib/dashboard/params";
import type { TeamLeadOption } from "@/lib/dashboard/queries";

// GET form: submitting updates the URL (search params). The page parameter is
// intentionally omitted, so any search or owner change returns to page 1.
// Without JavaScript it is a plain GET form.
//
// The inputs are controlled and never remounted, so focus stays where it is
// while results update; when the URL changes from elsewhere (tab switch,
// back button) the values follow it.
export function ListFilters({
  tab,
  q,
  owner,
  status,
  paymentStatus,
  teamLeads,
  isAdmin,
}: {
  tab: DashboardTab;
  q: string;
  owner: string | null;
  // History tab only.
  status: HistoryStatus;
  // Payments tab only.
  paymentStatus: PaymentFilter;
  teamLeads: TeamLeadOption[];
  isAdmin: boolean;
}) {
  const searchId = useId();
  const ownerId = useId();
  const statusId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const hydrated = useHydrated();
  const router = useRouter();

  const [query, setQuery] = useState(q);
  const [ownerValue, setOwnerValue] = useState(owner ?? "");
  const [statusValue, setStatusValue] = useState(status);
  const [paymentValue, setPaymentValue] = useState(paymentStatus);
  const [synced, setSynced] = useState({ q, owner, status, paymentStatus });
  if (synced.q !== q || synced.owner !== owner || synced.status !== status || synced.paymentStatus !== paymentStatus) {
    setSynced({ q, owner, status, paymentStatus });
    setQuery(q);
    setOwnerValue(owner ?? "");
    setStatusValue(status);
    setPaymentValue(paymentStatus);
  }

  const noun =
    tab === "clients" ? "clients" : tab === "history" ? "proposal history" : tab === "payments" ? "payments" : "proposals";
  const placeholder =
    tab === "clients"
      ? "Search by client name or email"
      : tab === "payments"
        ? "Search by client or proposal"
        : "Search by title or client name";

  return (
    <Form
      action="/dashboard"
      replace
      scroll={false}
      role="search"
      aria-label={`Filter ${noun}`}
      className="flex flex-col gap-3 sm:flex-row sm:items-center"
    >
      {tab !== "clients" ? <input type="hidden" name="tab" value={tab} /> : null}

      <div className="relative min-w-0 flex-1">
        <label htmlFor={searchId} className="sr-only">
          Search {noun}
        </label>
        <Search
          className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-subtle"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          id={searchId}
          name="q"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          maxLength={SEARCH_MAX_LENGTH}
          placeholder={placeholder}
          className={`${inputStyles} pl-12 [&::-webkit-search-cancel-button]:hidden`}
        />
      </div>

      {isAdmin ? (
        <div className="sm:w-64">
          <label htmlFor={ownerId} className="sr-only">
            Team lead
          </label>
          <SelectChevron>
            <select
              id={ownerId}
              name="owner"
              value={ownerValue}
              className={selectStyles}
              onChange={(event) => {
                const form = event.currentTarget.form;
                flushSync(() => setOwnerValue(event.target.value));
                form?.requestSubmit();
              }}
            >
              <option value="">All team leads</option>
              {teamLeads.map((lead) => (
                <option key={lead.id} value={lead.id}>
                  {lead.fullName}
                </option>
              ))}
            </select>
          </SelectChevron>
        </div>
      ) : null}

      {tab === "history" ? (
        <div className="sm:w-56">
          <label htmlFor={statusId} className="sr-only">
            Status
          </label>
          <SelectChevron>
            <select
              id={statusId}
              name="status"
              value={statusValue}
              className={selectStyles}
              onChange={(event) => {
                const form = event.currentTarget.form;
                flushSync(() => setStatusValue(event.target.value as HistoryStatus));
                form?.requestSubmit();
              }}
            >
              {HISTORY_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {HISTORY_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </SelectChevron>
        </div>
      ) : null}

      {tab === "payments" ? (
        <div className="sm:w-60">
          <label htmlFor={statusId} className="sr-only">
            Payment status
          </label>
          <SelectChevron>
            <select
              id={statusId}
              name="status"
              value={paymentValue}
              className={selectStyles}
              onChange={(event) => {
                const form = event.currentTarget.form;
                flushSync(() => setPaymentValue(event.target.value as PaymentFilter));
                form?.requestSubmit();
              }}
            >
              {PAYMENT_FILTERS.map((value) => (
                <option key={value} value={value}>
                  {PAYMENT_FILTER_LABELS[value]}
                </option>
              ))}
            </select>
          </SelectChevron>
        </div>
      ) : null}

      <div className="flex gap-3">
        <SearchButton />
        {q ? (
          <button
            type="button"
            className={buttonStyles.subtle}
            disabled={!hydrated}
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
              router.replace(dashboardHref({ tab, owner, status, paymentStatus }), { scroll: false });
            }}
          >
            <X aria-hidden="true" />
            Clear search
          </button>
        ) : null}
      </div>
    </Form>
  );
}

function SearchButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={`${buttonStyles.secondary} flex-1 sm:flex-none`}>
      {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Search aria-hidden="true" />}
      Search
      {pending ? <span className="sr-only"> (searching…)</span> : null}
    </button>
  );
}
