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
          "Phase 1 source discovery overview using Apify-native queue, worker, domain coverage and billing telemetry for the Vietnam market.",
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

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Apify-native telemetry. Domain counts = unique sites; URL counts = discovered source pages. Vietnam market = any site serving Vietnamese users, any TLD."
      />

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4 xl:grid-cols-8">
        <Stat
          label="Master Domains"
          value={k.masterDomains}
          tone="ok"
          hint="Unique domains in the master source set"
        />
        <Stat
          label="Official Domains"
          value={k.officialDomains}
          hint="Unique domains currently classified official"
        />
        <Stat
          label="Master Source URLs"
          value={k.masterSourceUrls}
          hint="Apify native master queue"
        />
        <Stat
          label="Candidate URLs"
          value={k.candidateSources}
          hint="Pre-normalization discovery rows"
        />
        <Stat
          label="Official URLs"
          value={k.officialSourceUrls}
          hint="URL rows classified official — not brands"
        />
        <Stat
          label="Radar Domains"
          value={k.radarDomains}
          hint="Aggregator / affiliate / deal discovery domains"
        />
        <Stat
          label="Native Queue Pending"
          value={k.nativeQueuePending}
          tone={k.nativeQueuePending > 0 ? "ok" : "warn"}
          hint="Pending tasks in Apify native queue"
        />
        <Stat
          label="Active Workers"
          value={k.activeWorkers}
          tone={k.activeWorkers > 0 ? "ok" : "danger"}
          hint="Current Apify worker runs only"
        />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
        <Panel title="Discovery progress">
          <Metric label="Source URLs / hour" value={m.sourcesPerHour} />
          <Metric label="New domains / hour" value={m.domainsPerHour} />
          <Metric
            label="Qualified / 1k requests"
            value={m.qualifiedPer1k}
            hasData={m.hasWorkerData}
          />
          <Metric label="Official domain ratio" value={m.officialDomainRatio} unit="%" />
        </Panel>

        <Panel title="Native engine">
          <Metric label="Queue total" value={m.nativeQueueTotal} hasData={m.hasApifyData} />
          <Metric label="Queue handled" value={m.nativeQueueHandled} hasData={m.hasApifyData} />
          <Metric label="Queue pending" value={m.nativeQueuePending} hasData={m.hasApifyData} />
          <Metric label="Active workers" value={m.activeWorkers} />
          <Metric label="Active orchestrators" value={m.activeOrchestrators} />
          <Metric
            label="Actor slots used"
            value={m.activeActorJobs}
            hasData={m.hasApifyData}
          />
          <Metric
            label="Actor slot limit"
            value={m.maxConcurrentActorJobs}
            hasData={m.hasApifyData}
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
          <Metric label="Live requests" value={m.liveRequests} hasData={m.hasWorkerData} />
        </Panel>

        <Panel title="Apify billing">
          <Metric
            label="Monthly usage"
            value={m.monthlyUsageUsd}
            unit="USD"
            hasData={m.hasApifyData}
          />
          <Metric
            label="Monthly hard limit"
            value={m.maxMonthlyUsageUsd}
            unit="USD"
            hasData={m.hasApifyData}
          />
          <Metric
            label="Remaining to hard limit"
            value={m.monthlyRemainingUsd}
            unit="USD"
            hasData={m.hasApifyData}
            tone={m.monthlyRemainingUsd < 10 ? "warn" : "ok"}
          />
          <div className="pt-2">
            <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
              <span>Monthly usage</span>
              <span className="font-mono">
                {m.hasApifyData ? `${m.monthlyUsagePct.toFixed(1)}%` : "No Apify telemetry"}
              </span>
            </div>
            <Bar
              value={m.monthlyUsagePct}
              tone={m.monthlyUsagePct > 90 ? "danger" : m.monthlyUsagePct > 70 ? "warn" : "ok"}
            />
          </div>
        </Panel>
      </div>

      <div className="mt-3 rounded-md border border-border bg-card px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        Duplicate rate and saturation percentage were removed because the old formulas were not measuring native dedupe or real market coverage. Progress is now judged from unique-domain growth, native queue state, discovery yield and cross-cycle convergence.
      </div>
    </>
  );
}
