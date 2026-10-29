import { dashboardHref, type DashboardParams } from "@/lib/dashboard/params";
import type { ClientListRow, Page } from "@/lib/dashboard/queries";
import { formatCount, formatDate } from "@/lib/format";

import { EditClientDialog } from "./client-dialogs";
import { Cell, DataTable, Row } from "./data-table";
import { LoadError, NoRecords, NoResults, PastLastPage } from "./list-states";
import { Pagination } from "./pagination";

export function ClientsSection({
  result,
  params,
  isAdmin,
}: {
  result: Page<ClientListRow> | null;
  params: DashboardParams;
  isAdmin: boolean;
}) {
  if (!result) return <LoadError what="clients" />;

  if (result.rows.length === 0) {
    if (result.total > 0) {
      return (
        <PastLastPage
          firstPageHref={dashboardHref({ tab: "clients", owner: params.owner, q: params.q })}
        />
      );
    }
    if (params.q) {
      return (
        <NoResults query={params.q} clearHref={dashboardHref({ tab: "clients", owner: params.owner })} />
      );
    }
    return (
      <NoRecords
        title="No clients yet"
        hint={
          params.owner
            ? "This team lead has no clients yet."
            : "Use “Add client” to create your first client."
        }
      />
    );
  }

  const columns = [
    { label: "Client" },
    { label: "Email" },
    { label: "Proposals", className: "text-right" },
    { label: "Created" },
    ...(isAdmin ? [{ label: "Owner" }] : []),
    { label: "Actions", srOnly: true, className: "text-right" },
  ];

  return (
    <>
      <DataTable caption="Clients" columns={columns}>
        {result.rows.map((client) => (
          <Row key={client.id}>
            <Cell label="Client" primary className="break-words">
              {client.name}
            </Cell>
            <Cell label="Email" className="break-all text-muted">
              {client.email}
            </Cell>
            <Cell label="Proposals" className="tabular-nums md:text-right">
              {formatCount(client.proposal_count ?? 0)}
            </Cell>
            <Cell label="Created" className="whitespace-nowrap text-muted">
              {formatDate(client.created_at)}
            </Cell>
            {isAdmin ? (
              <Cell label="Owner" className="text-muted">
                {client.owner_name ?? "—"}
              </Cell>
            ) : null}
            <Cell label="Actions" actions className="md:text-right">
              <EditClientDialog client={{ id: client.id, name: client.name, email: client.email }} />
            </Cell>
          </Row>
        ))}
      </DataTable>
      <Pagination params={params} total={result.total} pageCount={result.pageCount} noun="clients" />
    </>
  );
}
