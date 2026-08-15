import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { getQueue } from "@/lib/dashboard.functions";
import { Empty, PageHeader, Panel, Stat, Table, Tag, Td, fmtDate, statusTone } from "@/components/dash";

const queueQuery = queryOptions({ queryKey: ["queue"], queryFn: () => getQueue() });

export const Route = createFileRoute("/queue")({
  head: () => ({
    meta: [
      { title: "Scan Queue — Source Scan Hub" },
      {
        name: "description",
        content:
          "Pending, running, retrying and completed discovery jobs with lane, priority and attempt counts.",
      },
      { property: "og:title", content: "Scan Queue — Source Scan Hub" },
      {
        property: "og:description",
        content: "Discovery job queue state, priorities and retries.",
      },
    ],
  }),
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(queueQuery);
  },
  component: QueuePage,
  errorComponent: ({ error }) => <div role="alert" className="text-xs text-danger">{error.message}</div>,
});

function QueuePage() {
  const { data } = useSuspenseQuery(queueQuery);
  const count = (s: string) => data.jobs.filter((j: any) => j.status === s).length;

  return (
    <>
      <PageHeader title="Scan Queue" subtitle="Queued discovery work. No jobs execute in Phase 1." />
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
        <Stat label="Pending" value={count("pending")} tone="warn" />
        <Stat label="Running" value={count("running")} tone="ok" />
        <Stat label="Retry" value={count("retry")} tone="warn" />
        <Stat label="Completed" value={count("completed")} tone="ok" />
        <Stat label="Failed" value={count("failed")} tone="danger" />
      </div>

      <div className="mt-3 grid gap-3">
        <Panel title="Jobs">
          {data.jobs.length === 0 ? (
            <Empty label="No jobs queued yet" />
          ) : (
            <Table head={["Job type", "Lane", "Status", "Priority", "Attempts", "Scheduled", "Finished", "Error"]}>
              {data.jobs.map((j: any) => (
                <tr key={j.id} className="border-b border-border/50 hover:bg-accent/40">
                  <Td mono>{j.job_type}</Td>
                  <Td mono>{j.lane ?? "—"}</Td>
                  <Td>
                    <Tag tone={statusTone(j.status)}>{j.status}</Tag>
                  </Td>
                  <Td mono>{j.priority}</Td>
                  <Td mono>
                    {j.attempts}/{j.max_attempts}
                  </Td>
                  <Td mono>{fmtDate(j.scheduled_at)}</Td>
                  <Td mono>{fmtDate(j.finished_at)}</Td>
                  <Td>
                    <span className="text-danger">{j.error ?? "—"}</span>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>

        <Panel title="Queue targets">
          {data.queue.length === 0 ? (
            <Empty label="No queued targets yet" />
          ) : (
            <Table head={["Target", "Domain", "Lane", "Status", "Priority", "Locked by", "Available at"]}>
              {data.queue.map((q: any) => (
                <tr key={q.id} className="border-b border-border/50 hover:bg-accent/40">
                  <Td>
                    <div className="max-w-[320px] truncate font-mono">{q.target_url ?? "—"}</div>
                  </Td>
                  <Td mono>{q.target_domain ?? "—"}</Td>
                  <Td mono>{q.lane ?? "—"}</Td>
                  <Td>
                    <Tag tone={statusTone(q.status)}>{q.status}</Tag>
                  </Td>
                  <Td mono>{q.priority}</Td>
                  <Td mono>{q.locked_by ?? "—"}</Td>
                  <Td mono>{fmtDate(q.available_at)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </div>
    </>
  );
}
