import { dashboardHref, PAYMENT_FILTER_LABELS, type DashboardParams } from "@/lib/dashboard/params";
import type { Page, PaymentListRow, PaymentSummary } from "@/lib/dashboard/queries";
import { formatCount, formatDateTime } from "@/lib/format";
import { formatPrice, isCurrencyCode } from "@/lib/proposals/currencies";
import { badgeStyles, calloutStyles } from "@/components/ui/styles";

import { NeedsReviewBadge, PaymentStatusBadge } from "./badges";
import { Cell, DataTable, Row } from "./data-table";
import { LoadError, NoRecords, NoResults, PastLastPage } from "./list-states";
import { Pagination } from "./pagination";
import { PaymentsAutoRefresh } from "./payments-auto-refresh";
import { RecoveryLinkDialog } from "./recovery-link-dialog";

// Payments tab: one row per checkout attempt, newest first. Every value
// comes from the database rows written by the server's checkout and PayPal
// verification code; nothing here can create or change a payment. RLS
// limits a Team Lead to payments for their own proposals; the CEO sees all
// and can filter by Team Lead. The page re-renders itself periodically
// (bounded, only while visible) so new and verified payments appear.

function amount(minor: number, currency: string) {
  return isCurrencyCode(currency) ? formatPrice(minor, currency) : `${minor} ${currency}`;
}

export function PaymentsSection({
  result,
  summary,
  params,
  isAdmin,
}: {
  result: Page<PaymentListRow> | null;
  summary: PaymentSummary | null;
  params: DashboardParams;
  isAdmin: boolean;
}) {
  return (
    <>
      <PaymentsAutoRefresh />
      <PaymentSummaryStrip summary={summary} />
      <PaymentRows result={result} params={params} isAdmin={isAdmin} />
    </>
  );
}

function PaymentSummaryStrip({ summary }: { summary: PaymentSummary | null }) {
  if (!summary) {
    return (
      <p role="alert" className={`${calloutStyles.error} mx-4 mb-4 sm:mx-6`}>
        Payment totals couldn&apos;t be loaded.
      </p>
    );
  }
  return (
    <dl
      className="mx-4 mb-4 grid grid-cols-2 gap-3 rounded-xl border border-border bg-surface-muted p-4 text-[15px] sm:mx-6 lg:grid-cols-4"
      data-payment-summary
    >
      <div>
        <dt className="text-muted">Completed payments</dt>
        <dd className="text-xl font-semibold tabular-nums text-navy" data-summary-completed>
          {formatCount(summary.completed)}
        </dd>
      </div>
      <div>
        <dt className="text-muted">Pending verification</dt>
        <dd className="text-xl font-semibold tabular-nums text-navy" data-summary-pending>
          {formatCount(summary.pending)}
        </dd>
      </div>
      <div className="col-span-2">
        <dt className="text-muted">Received, net of refunds (before PayPal fees)</dt>
        <dd className="flex flex-wrap gap-x-4 gap-y-1 text-xl font-semibold tabular-nums text-navy" data-summary-received>
          {summary.receivedByCurrency.length === 0 ? (
            <span className="text-base font-normal text-muted">No completed payments yet</span>
          ) : (
            summary.receivedByCurrency.map((entry) => (
              <span key={entry.currency} data-currency={entry.currency}>
                {amount(entry.amountMinor, entry.currency)}
              </span>
            ))
          )}
        </dd>
      </div>
      {summary.needsReview > 0 ? (
        <p className={`${calloutStyles.warning} col-span-2 lg:col-span-4`}>
          {formatCount(summary.needsReview)} {summary.needsReview === 1 ? "payment needs" : "payments need"} review: PayPal
          reported something that didn&apos;t match the checkout, so no access was granted.{" "}
          {summary.needsReview === 1 ? "Check it in PayPal." : "Check them in PayPal."}
        </p>
      ) : null}
    </dl>
  );
}

function PaymentRows({
  result,
  params,
  isAdmin,
}: {
  result: Page<PaymentListRow> | null;
  params: DashboardParams;
  isAdmin: boolean;
}) {
  if (!result) return <LoadError what="payments" />;

  const base = { tab: "payments" as const, owner: params.owner, paymentStatus: params.paymentStatus };

  if (result.rows.length === 0) {
    if (result.total > 0) return <PastLastPage firstPageHref={dashboardHref({ ...base, q: params.q })} />;
    if (params.q) return <NoResults query={params.q} clearHref={dashboardHref(base)} />;
    if (params.paymentStatus !== "all") {
      return (
        <NoRecords
          title="No matching payments"
          hint={`No payments with the status “${PAYMENT_FILTER_LABELS[params.paymentStatus]}”.`}
        />
      );
    }
    return (
      <NoRecords
        title="No payments yet"
        hint="Payments appear here when a client starts paying for a proposal through its private link."
      />
    );
  }

  const columns = [
    { label: "Client" },
    { label: "Proposal" },
    ...(isAdmin ? [{ label: "Team Lead" }] : []),
    { label: "Amount" },
    { label: "Status" },
    { label: "Verified" },
    { label: "PayPal reference" },
    { label: "Actions", srOnly: true, className: "text-right" },
  ];

  return (
    <>
      <DataTable caption="Payments" columns={columns}>
        {result.rows.map((payment) => {
          const completed = payment.status === "succeeded" || payment.status === "partially_refunded";
          return (
            <Row key={payment.id}>
              <Cell label="Client" primary className="break-words">
                {payment.client_name ?? "—"}
              </Cell>
              <Cell label="Proposal" className="break-words">
                <span className="block text-foreground">{payment.proposal_title ?? "—"}</span>
                {payment.revision_id ? (
                  <span className="block text-xs text-subtle" title={`PDF revision ${payment.revision_id}`}>
                    PDF revision {payment.revision_id.slice(0, 8)}
                  </span>
                ) : null}
              </Cell>
              {isAdmin ? (
                <Cell label="Team Lead" className="text-muted">
                  {payment.owner_name ?? "—"}
                </Cell>
              ) : null}
              <Cell label="Amount" className="whitespace-nowrap tabular-nums">
                {amount(payment.amount_minor, payment.currency)}
                {payment.refunded_amount_minor > 0 ? (
                  <span className="block text-xs text-subtle">
                    {amount(payment.refunded_amount_minor, payment.currency)} refunded
                  </span>
                ) : null}
              </Cell>
              <Cell label="Status">
                <span className="flex flex-wrap items-center gap-1.5">
                  <PaymentStatusBadge status={payment.status} />
                  {payment.needs_review ? <NeedsReviewBadge reason={payment.review_reason} /> : null}
                  {payment.environment === "sandbox" ? <span className={badgeStyles.outline}>Sandbox</span> : null}
                </span>
              </Cell>
              <Cell label="Verified" className="whitespace-nowrap text-muted">
                {payment.verified_at ? formatDateTime(payment.verified_at) : <span aria-label="Not verified">—</span>}
              </Cell>
              <Cell label="PayPal reference" className="font-mono text-[13px] text-muted">
                {payment.provider_payment_id ? (
                  <span title="PayPal capture (transaction) ID">{payment.provider_payment_id}</span>
                ) : payment.provider_order_id ? (
                  <span title="PayPal order ID (not captured)">Order {payment.provider_order_id}</span>
                ) : (
                  "—"
                )}
              </Cell>
              <Cell label="Actions" actions className="md:text-right">
                {completed ? (
                  <RecoveryLinkDialog
                    payment={{
                      id: payment.id,
                      title: payment.proposal_title ?? "Proposal",
                      clientName: payment.client_name ?? "—",
                    }}
                  />
                ) : null}
              </Cell>
            </Row>
          );
        })}
      </DataTable>
      <Pagination params={params} total={result.total} pageCount={result.pageCount} noun="payments" />
    </>
  );
}
