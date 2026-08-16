import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  getPromoCommits,
  getPromoMaster,
  getPromoQueueStats,
  getPromoWorkers,
} from "@/lib/promo.functions";
import { Bar, Empty, PageHeader, Panel, Stat, Table, Tag, Td, fmtDate, statusTone } from "@/components/dash";

const REFRESH_MS = 15_000;

export const Route = createFileRoute("/promo")({
  head: () => ({
    meta: [
      { title: "PROMO Master — Source Scan Hub" },
      {
        name: "description",
        content:
          "Live PROMO master progress: batch checkpoint, scan coverage, actionable yield, writer health, candidate queue and commit ledger.",
      },
      { property: "og:title", content: "PROMO Master — Source Scan Hub" },
      {
        property: "og:description",
        content: "Live observability for the PROMO durable master writer.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PromoPage,
  errorComponent: ({ error }) => (
    <div role="alert" className="text-xs text-danger">
      {error.message}
    </div>
  ),
});

function useLive<T>(key: string, fn: () => Promise<T>) {
  return useQuery({
    queryKey: [key],
    queryFn: fn,
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}

function PanelError({ message }: { message: string }) {
  return (
    <div className="rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-[11px] text-warn">
      Data unavailable: {message}
    </div>
  );
}

function ago(iso?: string | null) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function minutesSince(iso?: string | null) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

function PromoPage() {
  const master = useLive("promo-master", () => getPromoMaster());
  const queue = useLive("promo-queue-stats", () => getPromoQueueStats());
  const commits = useLive("promo-commits", () => getPromoCommits());
  const workers = useLive("promo-workers", () => getPromoWorkers());
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);

  const refreshAll = async () => {
    await Promise.all([master.refetch(), queue.refetch(), commits.refetch(), workers.refetch()]);
    setRefreshedAt(new Date().toISOString());
  };

  const state: any = master.data?.state ?? null;
  const health: any = master.data?.health ?? null;
  const lastRefreshed = refreshedAt ?? master.data?.fetchedAt ?? null;

  const registered = Number(state?.registered_sources ?? 0);
  const scanned = Number(state?.scanned_sources ?? 0);
  const offers = Number(state?.actionable_offers ?? 0);
  const coveragePct = registered > 0 ? (scanned / registered) * 100 : 0;
  const yieldPct = scanned > 0 ? (offers / scanned) * 100 : 0;
  const commitAgeMin = minutesSince(state?.last_successful_commit ?? health?.last_successful_commit);
  const fresh = commitAgeMin < 180;

  return (
    <>
      <PageHeader
        title="PROMO Master"
        subtitle="Live observability from the canonical Supabase master tables. Progress ≠ production-completion estimate."
        right={
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              <span className="size-2 animate-pulse rounded-full bg-ok" />
              Live · {REFRESH_MS / 1000}s
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              Last refreshed {lastRefreshed ? new Date(lastRefreshed).toLocaleTimeString() : "—"}
            </span>
            <button
              type="button"
              onClick={refreshAll}
              className="rounded border border-border bg-card px-2 py-1 font-mono text-[11px] hover:bg-accent"
            >
              Refresh
            </button>
          </div>
        }
      />

      {master.isError ? (
        <PanelError message={(master.error as Error).message} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4 xl:grid-cols-6">
            <Stat label="Batch" value={state?.batch_no ?? 0} tone="ok" hint="Canonical batch_no" />
            <Stat label="Checkpoint" value={state?.checkpoint ?? "—"} hint="Master checkpoint" />
            <Stat label="Registered sources" value={registered} hint="registered_sources" />
            <Stat label="Scanned sources" value={scanned} hint="scanned_sources" />
            <Stat label="Actionable offers" value={offers} hint="actionable_offers" />
            <Stat label="Literal codes" value={state?.literal_codes ?? 0} hint="literal_codes" />
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <Panel title="Scan coverage (progress, not completion estimate)">
              <div className="mb-1 flex items-baseline justify-between font-mono text-xs">
                <span className="text-muted-foreground">
                  scanned / registered · {scanned} / {registered}
                </span>
                <span>{coveragePct.toFixed(1)}%</span>
              </div>
              <Bar value={coveragePct} tone={coveragePct > 66 ? "ok" : coveragePct > 33 ? "warn" : "danger"} />

              <div className="mb-1 mt-4 flex items-baseline justify-between font-mono text-xs">
                <span className="text-muted-foreground">
                  actionable yield · offers / scanned · {offers} / {scanned}
                </span>
                <span>{yieldPct.toFixed(1)}%</span>
              </div>
              <Bar value={Math.min(100, yieldPct)} tone="ok" />

              <div className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                Coverage measures how much of the registered source set has been scanned. Yield
                measures actionable offers per scanned source. Neither predicts total market
                completion.
              </div>
            </Panel>

            <Panel title="One-master-writer health">
              <div className="grid grid-cols-2 gap-2">
                <Stat
                  label="Writer state"
                  value={fresh ? "FRESH" : "STALE"}
                  tone={fresh ? "ok" : "warn"}
                  hint={`Last commit ${ago(state?.last_successful_commit ?? health?.last_successful_commit)}`}
                />
                <Stat
                  label="Ready backlog"
                  value={health?.ready_backlog ?? 0}
                  tone={Number(health?.ready_backlog ?? 0) > 0 ? "warn" : "ok"}
                  hint="Uncommitted READY rows"
                />
                <Stat label="Committed rows" value={health?.committed_rows ?? 0} hint="Lifetime committed" />
                <Stat
                  label="Value filter"
                  value={state?.value_filter_version ?? "—"}
                  hint="value_filter_version"
                />
              </div>
              <div className="mt-2 font-mono text-[11px] text-muted-foreground">
                last_successful_commit ·{" "}
                {fmtDate(state?.last_successful_commit ?? health?.last_successful_commit)}
              </div>
            </Panel>
          </div>
        </>
      )}

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Panel title="Candidate queue">
          {queue.isError ? (
            <PanelError message={(queue.error as Error).message} />
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Ready" value={queue.data?.ready ?? 0} tone="warn" />
              <Stat label="Committed" value={queue.data?.committed ?? 0} tone="ok" />
              <Stat label="Rejected" value={queue.data?.rejected ?? 0} tone="danger" />
              <Stat
                label="Oldest ready"
                value={queue.data?.oldestReadyAt ? ago(queue.data.oldestReadyAt) : "—"}
                hint="Age of oldest READY row"
              />
            </div>
          )}
        </Panel>

        <Panel title="Recent master commits">
          {commits.isError ? (
            <PanelError message={(commits.error as Error).message} />
          ) : (commits.data ?? []).length === 0 ? (
            <Empty label="No commits recorded yet" />
          ) : (
            <Table head={["Batch", "Checkpoint", "Δreg", "Δscan", "Δoffers", "Δcodes", "Rows", "Committed", "Commit id"]}>
              {(commits.data ?? []).map((c: any) => (
                <tr key={c.commit_id} className="border-b border-border/50 hover:bg-accent/40">
                  <Td mono>
                    {c.previous_batch_no}→{c.batch_no}
                  </Td>
                  <Td mono>{c.checkpoint}</Td>
                  <Td mono>{c.registered_delta}</Td>
                  <Td mono>{c.scanned_delta}</Td>
                  <Td mono>{c.offers_delta}</Td>
                  <Td mono>{c.codes_delta}</Td>
                  <Td mono>{c.rows}</Td>
                  <Td mono>{fmtDate(c.created_at)}</Td>
                  <Td mono>{String(c.commit_id).slice(0, 8)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </div>

      <div className="mt-3">
        <Panel title="Workers by lane">
          {workers.isError ? (
            <PanelError message={(workers.error as Error).message} />
          ) : (workers.data ?? []).length === 0 ? (
            <Empty label="No workers registered yet" />
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {[...(workers.data ?? [])]
                .sort(
                  (a: any, b: any) =>
                    minutesSince(a.last_heartbeat) - minutesSince(b.last_heartbeat),
                )
                .map((w: any) => {
                  const stale = minutesSince(w.last_heartbeat) > 10;
                  return (
                    <div key={w.id} className="rounded-md border border-border bg-card p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-xs">{w.worker_id}</span>
                        <Tag tone={stale ? "muted" : statusTone(w.status)}>
                          {stale ? "stale" : w.status}
                        </Tag>
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                        lane {w.lane ?? "—"} · heartbeat {ago(w.last_heartbeat)}
                      </div>
                      <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[11px]">
                        <div>
                          <div className="text-muted-foreground">req</div>
                          {w.requests_total}
                        </div>
                        <div>
                          <div className="text-muted-foreground">qualified</div>
                          {w.qualified_sources_total}
                        </div>
                        <div>
                          <div className="text-muted-foreground">errors</div>
                          {w.errors_total}
                        </div>
                        <div>
                          <div className="text-muted-foreground">403</div>
                          {Number(w.rate_403 ?? 0).toFixed(1)}%
                        </div>
                        <div>
                          <div className="text-muted-foreground">429</div>
                          {Number(w.rate_429 ?? 0).toFixed(1)}%
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
