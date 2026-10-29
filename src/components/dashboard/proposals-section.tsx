import { dashboardHref, type DashboardParams } from "@/lib/dashboard/params";
import type { Page, ProposalListRow } from "@/lib/dashboard/queries";
import { formatDate } from "@/lib/format";

import { PdfStateBadge, ProposalStatusBadge } from "./badges";
import { Cell, DataTable, Row } from "./data-table";
import { LoadError, NoRecords, NoResults, PastLastPage } from "./list-states";
import { Pagination } from "./pagination";
import { EditProposalTitleDialog } from "./proposal-dialogs";
import { ProposalSetupDialog, type PdfLimitsProps } from "./proposal-setup-dialog";

export function ProposalsSection({
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
  if (!result) return <LoadError what="proposals" />;

  if (result.rows.length === 0) {
    if (result.total > 0) {
      return (
        <PastLastPage
          firstPageHref={dashboardHref({ tab: "proposals", owner: params.owner, q: params.q })}
        />
      );
    }
    if (params.q) {
      return (
        <NoResults query={params.q} clearHref={dashboardHref({ tab: "proposals", owner: params.owner })} />
      );
    }
    return (
      <NoRecords
        title="No proposals yet"
        hint={
          params.owner
            ? "This team lead has no proposals yet."
            : "Use “New proposal” to create a draft for one of your clients."
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
    ...(isAdmin ? [{ label: "Owner" }] : []),
    { label: "Actions", srOnly: true, className: "text-right" },
  ];

  return (
    <>
      <DataTable caption="Proposals" columns={columns}>
        {result.rows.map((proposal) => (
          <Row key={proposal.id}>
            <Cell label="Proposal" primary className="break-words">
              {proposal.title}
            </Cell>
            <Cell label="Client" className="break-words text-muted">
              {proposal.client_name}
            </Cell>
            <Cell label="Status">
              <ProposalStatusBadge
                status={proposal.status}
                deletionPending={proposal.deletion_requested_at !== null}
              />
            </Cell>
            <Cell label="Document">
              <PdfStateBadge
                hasOriginal={proposal.has_original}
                hasPreview={proposal.has_preview}
                accessMode={proposal.access_mode}
                sourceFormat={proposal.source_format}
              />
            </Cell>
            <Cell label="Created" className="whitespace-nowrap text-muted">
              {formatDate(proposal.created_at)}
            </Cell>
            {isAdmin ? (
              <Cell label="Owner" className="text-muted">
                {proposal.owner_name ?? "—"}
              </Cell>
            ) : null}
            <Cell label="Actions" actions className="md:text-right">
              <div className="flex flex-wrap items-center gap-1.5 md:flex-nowrap md:justify-end">
                {proposal.deletion_requested_at !== null ? (
                  <span className="text-sm text-subtle">Being deleted (see History)</span>
                ) : proposal.status === "draft" ? (
                  <EditProposalTitleDialog proposal={{ id: proposal.id, title: proposal.title }} />
                ) : null}
                {proposal.deletion_requested_at !== null ? null : proposal.status === "archived" ? (
                  <span className="text-sm text-subtle">Not editable</span>
                ) : (
                  <ProposalSetupDialog
                    proposal={{ id: proposal.id, title: proposal.title }}
                    limits={pdfLimits}
                  />
                )}
              </div>
            </Cell>
          </Row>
        ))}
      </DataTable>
      <Pagination params={params} total={result.total} pageCount={result.pageCount} noun="proposals" />
    </>
  );
}
