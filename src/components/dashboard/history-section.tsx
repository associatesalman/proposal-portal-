import { dashboardHref, HISTORY_STATUS_LABELS, type DashboardParams } from "@/lib/dashboard/params";
import type { Page, ProposalListRow } from "@/lib/dashboard/queries";
import { formatDate } from "@/lib/format";

import { PdfStateBadge, ProposalStatusBadge } from "./badges";
import { Cell, DataTable, Row } from "./data-table";
import { LoadError, NoRecords, NoResults, PastLastPage } from "./list-states";
import { Pagination } from "./pagination";
import { DeleteProposalDialog } from "./proposal-dialogs";
import { ProposalSetupDialog, type PdfLimitsProps } from "./proposal-setup-dialog";

// Proposal History: every proposal the user may see (drafts and issued),
// newest first, built from the proposals table itself (no copy). RLS limits
// a team lead to their own proposals in the database query; the owner and
// status filters narrow further, server-side.
export function HistorySection({
  result,
  params,
  isAdmin,
  pdfLimits,
}: {
  result: Page<ProposalListRow> | null;
  params: DashboardParams;
  isAdmin: boolean;
  pdfLimits: PdfLimitsProps;
}) {
  if (!result) return <LoadError what="proposal history" />;

  const base = { tab: "history" as const, owner: params.owner, status: params.status };

  if (result.rows.length === 0) {
    if (result.total > 0) {
      return <PastLastPage firstPageHref={dashboardHref({ ...base, q: params.q })} />;
    }
    if (params.q) {
      return <NoResults query={params.q} clearHref={dashboardHref(base)} />;
    }
    if (params.status !== "all") {
      return (
        <NoRecords
          title="No matching proposals"
          hint={`No proposals with the status “${HISTORY_STATUS_LABELS[params.status]}”.`}
        />
      );
    }
    return (
      <NoRecords
        title="No proposal history yet"
        hint={
          params.owner
            ? "This team lead has no proposals yet."
            : "Proposals appear here once created, including drafts and issued links."
        }
      />
    );
  }

  const columns = [
    { label: "Proposal" },
    { label: "Client" },
    { label: "Status" },
    { label: "Document" },
    { label: "Created" },
    { label: "Link issued" },
    ...(isAdmin ? [{ label: "Owner" }] : []),
    { label: "Actions", srOnly: true, className: "text-right" },
  ];

  return (
    <>
      <DataTable caption="Proposal history" columns={columns}>
        {result.rows.map((proposal) => {
          const deleting = proposal.deletion_requested_at !== null;
          return (
            <Row key={proposal.id}>
              <Cell label="Proposal" primary className="break-words">
                {proposal.title}
              </Cell>
              <Cell label="Client" className="break-words text-muted">
                {proposal.client_name}
              </Cell>
              <Cell label="Status">
                <ProposalStatusBadge status={proposal.status} deletionPending={deleting} />
              </Cell>
              <Cell label="Document">
                <PdfStateBadge
                  hasOriginal={proposal.has_original}
                  hasPreview={proposal.has_preview}
                  sourceFormat={proposal.source_format}
                />
              </Cell>
              <Cell label="Created" className="whitespace-nowrap text-muted">
                {formatDate(proposal.created_at)}
              </Cell>
              <Cell label="Link issued" className="whitespace-nowrap text-muted">
                {proposal.link_created_at ? (
                  formatDate(proposal.link_created_at)
                ) : (
                  <>
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">No active link</span>
                  </>
                )}
              </Cell>
              {isAdmin ? (
                <Cell label="Owner" className="text-muted">
                  {proposal.owner_name ?? "—"}
                </Cell>
              ) : null}
              <Cell label="Actions" actions className="md:text-right">
                <div className="flex flex-wrap items-center gap-1.5 md:flex-nowrap md:justify-end">
                  {!deleting && proposal.status !== "archived" ? (
                    <ProposalSetupDialog proposal={{ id: proposal.id, title: proposal.title }} limits={pdfLimits} />
                  ) : null}
                  {proposal.has_payments ? (
                    <span className="text-sm text-subtle" title="Payment records must be kept">
                      Kept: has payments
                    </span>
                  ) : (
                    <DeleteProposalDialog
                      proposal={{
                        id: proposal.id,
                        title: proposal.title,
                        clientName: proposal.client_name,
                        pending: deleting,
                      }}
                    />
                  )}
                </div>
              </Cell>
            </Row>
          );
        })}
      </DataTable>
      <Pagination params={params} total={result.total} pageCount={result.pageCount} noun="proposals" />
    </>
  );
}
