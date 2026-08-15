import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { getSources } from "@/lib/dashboard.functions";
import { Bar, Empty, PageHeader, Panel, Table, Tag, Td, fmtDate, statusTone } from "@/components/dash";

const radarQuery = queryOptions({ queryKey: ["sources"], queryFn: () => getSources() });

export const Route = createFileRoute("/radar")({
  head: () => ({
    meta: [
      { title: "Radar — Source Scan Hub" },
      {
        name: "description",
        content:
          "Intermediary radar sources — aggregators and hubs that lead to new merchant origins — ranked by yield score.",
      },
      { property: "og:title", content: "Radar — Source Scan Hub" },
      {
        property: "og:description",
        content: "Intermediary radar sources ranked by discovery yield.",
      },
    ],
  }),
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(radarQuery);
  },
  component: RadarPage,
  errorComponent: ({ error }) => <div role="alert" className="text-xs text-danger">{error.message}</div>,
});

function RadarPage() {
  const { data } = useSuspenseQuery(radarQuery);
  const rows = data
    .filter((r: any) => r.is_radar)
    .sort((a: any, b: any) => Number(b.yield_score ?? 0) - Number(a.yield_score ?? 0));
  const max = Math.max(1, ...rows.map((r: any) => Number(r.yield_score ?? 0)));

  return (
    <>
      <PageHeader
        title="Radar"
        subtitle="Intermediary sources only — aggregators, deal hubs and directories that surface new origins."
        right={<span className="font-mono text-xs text-muted-foreground">{rows.length} radar sources</span>}
      />
      <Panel>
        {rows.length === 0 ? (
          <Empty label="No radar sources flagged yet" />
        ) : (
          <Table head={["Domain / URL", "Type", "Market", "Yield score", "Status", "Last scan"]}>
            {rows.map((r: any) => (
              <tr key={`${r.kind}-${r.id}`} className="border-b border-border/50 hover:bg-accent/40">
                <Td>
                  <div className="max-w-[380px] truncate font-mono">{r.domain ?? r.url}</div>
                  <div className="max-w-[380px] truncate text-[10px] text-muted-foreground">{r.url}</div>
                </Td>
                <Td mono>{r.source_type ?? "—"}</Td>
                <Td mono>{r.market ?? "—"}</Td>
                <Td>
                  <div className="w-40">
                    <div className="mb-1 font-mono text-[11px]">{Number(r.yield_score ?? 0).toFixed(2)}</div>
                    <Bar value={(Number(r.yield_score ?? 0) / max) * 100} />
                  </div>
                </Td>
                <Td>
                  <Tag tone={statusTone(r.status)}>{r.status}</Tag>
                </Td>
                <Td mono>{fmtDate(r.last_scan_at)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}
