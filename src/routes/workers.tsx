import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { getWorkers } from "@/lib/dashboard.functions";
import { Empty, PageHeader, Panel, Table, Tag, Td, fmtDate, statusTone } from "@/components/dash";

const workersQuery = queryOptions({ queryKey: ["workers"], queryFn: () => getWorkers() });

export const Route = createFileRoute("/workers")({
  head: () => ({
    meta: [
      { title: "Workers — Source Scan Hub" },
      {
        name: "description",
        content:
          "Worker fleet health: lane, status, heartbeat, request volume, qualified sources and 403/429/error rates.",
      },
      { property: "og:title", content: "Workers — Source Scan Hub" },
      { property: "og:description", content: "Discovery worker fleet health and throughput." },
    ],
  }),
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(workersQuery);
  },
  component: WorkersPage,
  errorComponent: ({ error }) => <div role="alert" className="text-xs text-danger">{error.message}</div>,
});

function rateTone(v: number) {
  if (v >= 10) return "danger" as const;
  if (v >= 3) return "warn" as const;
  return "ok" as const;
}

function WorkersPage() {
  const { data } = useSuspenseQuery(workersQuery);

  return (
    <>
      <PageHeader
        title="Workers"
        subtitle="Fleet telemetry. Workers are idle in Phase 1 — no live crawling."
        right={<span className="font-mono text-xs text-muted-foreground">{data.length} workers</span>}
      />
      <Panel>
        {data.length === 0 ? (
          <Empty label="No workers registered yet" />
        ) : (
          <Table
            head={[
              "Worker",
              "Lane",
              "Status",
              "Heartbeat",
              "Requests",
              "Qualified",
              "Errors",
              "403 rate",
              "429 rate",
            ]}
          >
            {data.map((w: any) => (
              <tr key={w.id} className="border-b border-border/50 hover:bg-accent/40">
                <Td mono>{w.worker_id}</Td>
                <Td mono>{w.lane ?? "—"}</Td>
                <Td>
                  <Tag tone={statusTone(w.status)}>{w.status}</Tag>
                </Td>
                <Td mono>{fmtDate(w.last_heartbeat)}</Td>
                <Td mono>{w.requests_total}</Td>
                <Td mono>{w.qualified_sources_total}</Td>
                <Td mono>{w.errors_total}</Td>
                <Td>
                  <Tag tone={rateTone(Number(w.rate_403 ?? 0))}>
                    {Number(w.rate_403 ?? 0).toFixed(1)}%
                  </Tag>
                </Td>
                <Td>
                  <Tag tone={rateTone(Number(w.rate_429 ?? 0))}>
                    {Number(w.rate_429 ?? 0).toFixed(1)}%
                  </Tag>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}
