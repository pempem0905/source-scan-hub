import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { getApiUsage } from "@/lib/dashboard.functions";
import { Bar, Empty, PageHeader, Panel, Stat, Table, Td, fmtDate } from "@/components/dash";

const usageQuery = queryOptions({ queryKey: ["api-usage"], queryFn: () => getApiUsage() });

export const Route = createFileRoute("/api-cost")({
  head: () => ({
    meta: [
      { title: "API & Cost — Source Scan Hub" },
      {
        name: "description",
        content:
          "Provider-level API request volume, credit consumption, USD cost and progress against daily and project budgets.",
      },
      { property: "og:title", content: "API & Cost — Source Scan Hub" },
      { property: "og:description", content: "API spend and budget tracking for source discovery." },
    ],
  }),
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(usageQuery);
  },
  component: ApiCostPage,
  errorComponent: ({ error }) => <div role="alert" className="text-xs text-danger">{error.message}</div>,
});

function budgetOf(config: any[], key: string): number | null {
  const row = config.find((c) => c.key === key);
  if (!row) return null;
  const v: any = row.value;
  const n = typeof v === "object" && v !== null ? Number(v.value ?? v.amount) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function ApiCostPage() {
  const { data } = useSuspenseQuery(usageQuery);
  const rows = data.usage;
  const total = rows.reduce(
    (a: any, r: any) => ({
      requests: a.requests + Number(r.requests ?? 0),
      credits: a.credits + Number(r.credits ?? 0),
      cost: a.cost + Number(r.cost_usd ?? 0),
    }),
    { requests: 0, credits: 0, cost: 0 },
  );

  const today = new Date().toISOString().slice(0, 10);
  const todayCost = rows
    .filter((r: any) => r.usage_date === today)
    .reduce((a: number, r: any) => a + Number(r.cost_usd ?? 0), 0);

  const daily = budgetOf(data.config, "daily_budget_usd");
  const project = budgetOf(data.config, "project_budget_usd");

  const bar = (spend: number, budget: number | null, label: string) => {
    const pct = budget && budget > 0 ? (spend / budget) * 100 : 0;
    return (
      <div className="py-2">
        <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
          <span>{label}</span>
          <span className="font-mono">
            {budget ? `$${spend.toFixed(2)} / $${budget} (${pct.toFixed(1)}%)` : "No budget configured"}
          </span>
        </div>
        <Bar value={pct} tone={pct > 90 ? "danger" : pct > 60 ? "warn" : "ok"} />
      </div>
    );
  };

  return (
    <>
      <PageHeader title="API & Cost" subtitle="Spend recorded per provider and day. No external calls in Phase 1." />
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat label="Requests" value={total.requests} />
        <Stat label="Credits" value={total.credits} />
        <Stat label="Total cost (USD)" value={`$${total.cost.toFixed(2)}`} />
        <Stat label="Today cost (USD)" value={`$${todayCost.toFixed(2)}`} />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Panel title="Budget" className="lg:col-span-1">
          {bar(todayCost, daily, "Daily budget")}
          {bar(total.cost, project, "Project budget")}
        </Panel>
        <Panel title="Usage by provider / day" className="lg:col-span-2">
          {rows.length === 0 ? (
            <Empty label="No API usage recorded yet" />
          ) : (
            <Table head={["Provider", "Date", "Requests", "Credits", "Cost USD"]}>
              {rows.map((r: any) => (
                <tr key={r.id} className="border-b border-border/50 hover:bg-accent/40">
                  <Td mono>{r.provider}</Td>
                  <Td mono>{fmtDate(r.usage_date).slice(0, 10)}</Td>
                  <Td mono>{r.requests}</Td>
                  <Td mono>{r.credits}</Td>
                  <Td mono>${Number(r.cost_usd ?? 0).toFixed(2)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </div>
    </>
  );
}
