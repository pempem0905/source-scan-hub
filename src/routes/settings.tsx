import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { getConfig } from "@/lib/dashboard.functions";
import { Empty, PageHeader, Panel, Stat, Table, Td, fmtDate } from "@/components/dash";

const configQuery = queryOptions({ queryKey: ["config"], queryFn: () => getConfig() });

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — Source Scan Hub" },
      {
        name: "description",
        content:
          "Read-only view of system configuration: phase, power mode, concurrency limits, retry limit and budgets.",
      },
      { property: "og:title", content: "Settings — Source Scan Hub" },
      { property: "og:description", content: "Current discovery system configuration (read-only)." },
    ],
  }),
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(configQuery);
  },
  component: SettingsPage,
  errorComponent: ({ error }) => <div role="alert" className="text-xs text-danger">{error.message}</div>,
});

const KEYS = [
  ["phase", "Phase"],
  ["power_mode", "Power mode"],
  ["global_concurrency", "Global concurrency"],
  ["per_domain_concurrency", "Per-domain concurrency"],
  ["retry_limit", "Retry limit"],
  ["daily_budget_usd", "Daily budget (USD)"],
  ["project_budget_usd", "Project budget (USD)"],
] as const;

function render(value: unknown): string {
  if (value === null || value === undefined) return "Not set";
  if (typeof value === "object") {
    const v: any = value;
    if ("value" in v) return String(v.value);
    return JSON.stringify(v);
  }
  return String(value);
}

function SettingsPage() {
  const { data } = useSuspenseQuery(configQuery);
  const byKey = new Map(data.map((r: any) => [r.key, r]));

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Read-only in Phase 1. Values come straight from system configuration; no writes are performed."
      />
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {KEYS.map(([key, label]) => {
          const row: any = byKey.get(key);
          return <Stat key={key} label={label} value={row ? render(row.value) : "Not set"} />;
        })}
      </div>

      <div className="mt-3">
        <Panel title="All configuration keys">
          {data.length === 0 ? (
            <Empty label="No configuration rows yet" />
          ) : (
            <Table head={["Key", "Value", "Description", "Updated"]}>
              {data.map((r: any) => (
                <tr key={r.key} className="border-b border-border/50 hover:bg-accent/40">
                  <Td mono>{r.key}</Td>
                  <Td mono>{render(r.value)}</Td>
                  <Td>{r.description ?? "—"}</Td>
                  <Td mono>{fmtDate(r.updated_at)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        Market scope note: "Vietnam market" covers the entire internet ecosystem serving Vietnamese
        users — international marketplaces, global brand sites, social platforms and regional
        aggregators — regardless of TLD. It is not restricted to .vn domains.
      </p>
    </>
  );
}
