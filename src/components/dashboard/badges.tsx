import { badgeStyles } from "@/components/ui/styles";
import { formatLabel } from "@/lib/documents/formats";
import type { Database } from "@/types/database";

type ProposalStatus = Database["public"]["Enums"]["proposal_status"];

const dot = "size-1.5 shrink-0 rounded-full";

const STATUS_STYLES: Record<ProposalStatus, { label: string; className: string; dot: string }> = {
  draft: { label: "Draft", className: badgeStyles.neutral, dot: "bg-slate-400" },
  active: { label: "Active", className: badgeStyles.accent, dot: "bg-accent" },
  archived: { label: "Archived", className: badgeStyles.outline, dot: "bg-slate-300" },
};

export function StatusBadge({ status }: { status: ProposalStatus }) {
  const style = STATUS_STYLES[status];
  return (
    <span className={style.className}>
      <span className={`${dot} ${style.dot}`} aria-hidden="true" />
      {style.label}
    </span>
  );
}

// PDF readiness is separate from lifecycle status.
export function PdfStateBadge({
  hasOriginal,
  hasPreview,
  sourceFormat = null,
}: {
  hasOriginal: boolean | null;
  hasPreview: boolean | null;
  // The original upload's format when it wasn't a PDF (converted).
  sourceFormat?: string | null;
}) {
  const badge = !hasOriginal ? (
    <span className={badgeStyles.outline}>Not uploaded</span>
  ) : !hasPreview ? (
    <span className={badgeStyles.warning}>Uploaded</span>
  ) : (
    <span className={badgeStyles.success}>Preview ready</span>
  );
  if (!hasOriginal || !sourceFormat) return badge;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {badge}
      <span className="text-xs text-subtle" title={`Uploaded as ${formatLabel(sourceFormat)}, converted to PDF`}>
        {formatLabel(sourceFormat)}
      </span>
    </span>
  );
}

// A permanent deletion started but didn't finish (retryable). The proposal
// has no client link and can't be changed.
export function DeletionPendingBadge() {
  return (
    <span className={badgeStyles.danger}>
      <span className={`${dot} bg-danger`} aria-hidden="true" />
      Deletion pending
    </span>
  );
}

// Lifecycle status, or "Deletion pending" instead once deletion started.
export function ProposalStatusBadge({
  status,
  deletionPending,
}: {
  status: ProposalStatus;
  deletionPending: boolean;
}) {
  return deletionPending ? <DeletionPendingBadge /> : <StatusBadge status={status} />;
}

type PaymentStatus = Database["public"]["Enums"]["payment_status"];

const PAYMENT_STATUS_STYLES: Record<PaymentStatus, { label: string; className: string; dot: string }> = {
  created: { label: "Checkout not finished", className: badgeStyles.outline, dot: "bg-slate-300" },
  pending: { label: "Pending verification", className: badgeStyles.warning, dot: "bg-warning" },
  succeeded: { label: "Completed", className: badgeStyles.success, dot: "bg-success" },
  partially_refunded: { label: "Partially refunded", className: badgeStyles.accent, dot: "bg-accent" },
  refunded: { label: "Refunded", className: badgeStyles.neutral, dot: "bg-slate-400" },
  reversed: { label: "Reversed", className: badgeStyles.danger, dot: "bg-danger" },
  failed: { label: "Failed", className: badgeStyles.danger, dot: "bg-danger" },
  denied: { label: "Denied", className: badgeStyles.danger, dot: "bg-danger" },
  cancelled: { label: "Cancelled", className: badgeStyles.neutral, dot: "bg-slate-400" },
};

export function paymentStatusLabel(status: PaymentStatus): string {
  return PAYMENT_STATUS_STYLES[status].label;
}

// Verified PayPal state of one checkout attempt (written only by the server).
export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  const style = PAYMENT_STATUS_STYLES[status];
  return (
    <span className={style.className}>
      <span className={`${dot} ${style.dot}`} aria-hidden="true" />
      {style.label}
    </span>
  );
}

export function NeedsReviewBadge({ reason }: { reason: string | null }) {
  return (
    <span className={badgeStyles.danger} title={reason ?? undefined}>
      Needs review
    </span>
  );
}
