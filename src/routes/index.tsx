import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { getOverview } from "@/lib/dashboard.functions";
import { Bar, Metric, Panel, PageHeader, Stat } from "@/components/dash";

const overviewQuery = queryOptions({
  queryKey: ["overview"],
  queryFn: () => getOverview(),
});

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Overview — Source Scan Hub" },
      {
        name: "description",
        content:
          "Phase 1 source discovery overview: radar, candidate and official sources, queue depth, worker health and API cost for the Vietnam market.",
      },
      { property: "og:title", content: "Overview — Source Scan Hub" },
      {
        property: "og:description",
        content: "Internal Phase 1 source discovery operations dashboard.",
      },
    ],
  }),
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(overviewQuery);
  },
  component: Overview,
  errorComponent: ({ error }) => (
    <div role="alert" className="text-xs text-danger">
      {error.message}
    </div>
  ),
});

function Overview() {
  const { data } = useSuspenseQuery(overviewQuery);
  const k = data.kpis;
  const m = data.metrics;

  const budget = m.dailyBudget ?? m.projectBudget ?? null;
  const budgetPct = budget && budget > 0 ? (m.costUsd / budget) * 100 : 0;

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Discovery-only telemetry. Vietnam market = every site serving Vietnamese users, any TLD."
      />

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4 xl:grid-cols-8">
        <Stat label="Radar Sources" value={k.radarSources} />
        <Stat label="Candidate Sources" value={k.candidateSources} />
        <Stat label="Official Sources" value={k.officialSources} />
        <Stat label="Merchants" value={k.merchants} />
        <Stat label="Resolved Origins" value={k.resolvedOrigins} tone="ok" />
        <Stat label="Unresolved Origins" value={k.unresolvedOrigins} tone="warn" />
        <Stat label="Queue Depth" value={k.queueDepth} />
        <Stat label="Active Workers" value={k.activeWorkers} />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Panel title="Discovery throughput">
          <Metric label="Sources / hour" value={m.sourcesPerHour} />
          <Metric
            label="Qualified sources / 1k requests"
            value={m.qualifiedPer1k}
            hasData={m.hasWorkerData}
          />
          <Metric label="Duplicate rate" value={m.duplicateRate} unit="%" tone="warn" />
          <Metric
            label="Saturation estimate"
            value={m.saturation}
            unit="%"
            hasData={k.candidateSources > 0}
          />
        </Panel>

        <Panel title="Fetch health">
          <Metric label="403 rate" value={m.rate403} unit="%" tone="warn" hasData={m.hasWorkerData} />
          <Metric
            label="429 rate"
            value={m.rate429}
            unit="%"
            tone="warn"
            hasData={m.hasWorkerData}
          />
          <Metric
            label="Error rate"
            value={m.errorRate}
            unit="%"
            tone="danger"
            hasData={m.hasWorkerData}
          />
          <Metric label="Active workers" value={k.activeWorkers} />
        </Panel>

        <Panel title="API & cost">
          <Metric label="API requests" value={m.apiRequests} hasData={m.hasUsageData} />
          <Metric label="Credits used" value={m.credits} hasData={m.hasUsageData} />
          <Metric label="Total cost" value={m.costUsd} unit="USD" hasData={m.hasUsageData} />
          <div className="pt-2">
            <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
              <span>Budget usage</span>
              <span className="font-mono">
                {budget ? `${budgetPct.toFixed(1)}% of $${budget}` : "No budget configured"}
              </span>
            </div>
            <Bar
              value={budgetPct}
              tone={budgetPct > 90 ? "danger" : budgetPct > 60 ? "warn" : "ok"}
            />
          </div>
        </Panel>
      </div>
    </>
  );
}
