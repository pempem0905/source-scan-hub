import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { getResolver } from "@/lib/dashboard.functions";
import { Empty, PageHeader, Panel, Table, Tag, Td, fmtDate, statusTone } from "@/components/dash";

const resolverQuery = queryOptions({ queryKey: ["resolver"], queryFn: () => getResolver() });

export const Route = createFileRoute("/resolver")({
  head: () => ({
    meta: [
      { title: "Origin Resolver — Source Scan Hub" },
      {
        name: "description",
        content:
          "Trace discovered URLs to their canonical origin domain and review resolution status for each candidate.",
      },
      { property: "og:title", content: "Origin Resolver — Source Scan Hub" },
      {
        property: "og:description",
        content: "Discovered URL to canonical origin mapping and resolution status.",
      },
    ],
  }),
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(resolverQuery);
  },
  component: ResolverPage,
  errorComponent: ({ error }) => <div role="alert" className="text-xs text-danger">{error.message}</div>,
});

function ResolverPage() {
  const { data } = useSuspenseQuery(resolverQuery);

  return (
    <>
      <PageHeader
        title="Origin Resolver"
        subtitle="Discovered URL → canonical URL / origin domain. Redirects and mirrors collapse into one origin."
      />
      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="Resolution status by record">
          {data.rows.length === 0 ? (
            <Empty label="Nothing to resolve yet" />
          ) : (
            <Table head={["Discovered URL", "Canonical URL", "Origin domain", "HTTP", "Status", "Verified"]}>
              {data.rows.map((r: any) => (
                <tr key={r.id} className="border-b border-border/50 hover:bg-accent/40">
                  <Td>
                    <div className="max-w-[240px] truncate font-mono">{r.url}</div>
                  </Td>
                  <Td>
                    <div className="max-w-[240px] truncate font-mono">{r.canonical_url ?? "—"}</div>
                  </Td>
                  <Td mono>{r.canonical_domain ?? "—"}</Td>
                  <Td mono>{r.http_status ?? "—"}</Td>
                  <Td>
                    <Tag tone={statusTone(r.resolution_status)}>{r.resolution_status}</Tag>
                  </Td>
                  <Td mono>{fmtDate(r.verified_at)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>

        <Panel title="Discovery edges">
          {data.edges.length === 0 ? (
            <Empty label="No discovery edges recorded yet" />
          ) : (
            <Table head={["Type", "Discovered", "Final", "Canonical", "Confidence", "Created"]}>
              {data.edges.map((e: any) => (
                <tr key={e.id} className="border-b border-border/50 hover:bg-accent/40">
                  <Td>
                    <Tag tone="info">{e.edge_type}</Tag>
                  </Td>
                  <Td>
                    <div className="max-w-[200px] truncate font-mono">{e.discovered_url ?? "—"}</div>
                  </Td>
                  <Td>
                    <div className="max-w-[200px] truncate font-mono">{e.final_url ?? "—"}</div>
                  </Td>
                  <Td>
                    <div className="max-w-[200px] truncate font-mono">{e.canonical_url ?? "—"}</div>
                  </Td>
                  <Td mono>{e.confidence ?? "—"}</Td>
                  <Td mono>{fmtDate(e.created_at)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </div>
    </>
  );
}
