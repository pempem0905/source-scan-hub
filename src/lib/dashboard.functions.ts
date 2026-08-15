import { createServerFn } from "@tanstack/react-start";

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

export const getOverview = createServerFn({ method: "GET" }).handler(async () => {
  const db = await admin();

  const count = async (
    table: string,
    build?: (q: any) => any,
  ): Promise<number> => {
    let q: any = db.from(table).select("*", { count: "exact", head: true });
    if (build) q = build(q);
    const { count: c } = await q;
    return c ?? 0;
  };

  const [
    radarSources,
    candidateSources,
    officialSources,
    merchants,
    resolvedOrigins,
    unresolvedOrigins,
    queueDepth,
    activeWorkers,
    totalSources,
  ] = await Promise.all([
    count("sources", (q) => q.eq("is_radar", true)),
    count("source_candidates"),
    count("sources", (q) => q.eq("is_official", true)),
    count("merchants"),
    count("sources", (q) => q.eq("resolution_status", "resolved")),
    count("sources", (q) => q.neq("resolution_status", "resolved")),
    count("scan_queue", (q) => q.in("status", ["pending", "running", "retry"])),
    count("worker_stats", (q) => q.eq("status", "running")),
    count("sources"),
  ]);

  const { data: workers } = await db
    .from("worker_stats")
    .select("requests_total, qualified_sources_total, errors_total, rate_403, rate_429");

  const { data: usage } = await db.from("api_usage").select("requests, credits, cost_usd");

  const { data: recentSources } = await db
    .from("sources")
    .select("id")
    .gte("created_at", new Date(Date.now() - 3600_000).toISOString());

  const w = workers ?? [];
  const sum = (k: string) => w.reduce((a: number, r: any) => a + Number(r[k] ?? 0), 0);
  const avg = (k: string) =>
    w.length ? w.reduce((a: number, r: any) => a + Number(r[k] ?? 0), 0) / w.length : 0;

  const requests = sum("requests_total");
  const qualified = sum("qualified_sources_total");
  const errors = sum("errors_total");

  const { count: dupCandidates } = await db
    .from("source_candidates")
    .select("*", { count: "exact", head: true })
    .eq("status", "duplicate");

  const costUsd = (usage ?? []).reduce((a: number, r: any) => a + Number(r.cost_usd ?? 0), 0);
  const apiRequests = (usage ?? []).reduce((a: number, r: any) => a + Number(r.requests ?? 0), 0);
  const credits = (usage ?? []).reduce((a: number, r: any) => a + Number(r.credits ?? 0), 0);

  const { data: budgetRows } = await db
    .from("system_config")
    .select("key, value")
    .in("key", ["daily_budget_usd", "project_budget_usd"]);

  const budget = (key: string): number | null => {
    const row = (budgetRows ?? []).find((r: any) => r.key === key);
    if (!row) return null;
    const v: any = row.value;
    const n = typeof v === "object" && v !== null ? Number(v.value ?? v.amount) : Number(v);
    return Number.isFinite(n) ? n : null;
  };

  return {
    kpis: {
      radarSources,
      candidateSources,
      officialSources,
      merchants,
      resolvedOrigins,
      unresolvedOrigins,
      queueDepth,
      activeWorkers,
    },
    metrics: {
      sourcesPerHour: recentSources?.length ?? 0,
      qualifiedPer1k: requests > 0 ? (qualified / requests) * 1000 : 0,
      duplicateRate:
        candidateSources > 0 ? ((dupCandidates ?? 0) / candidateSources) * 100 : 0,
      rate403: avg("rate_403"),
      rate429: avg("rate_429"),
      errorRate: requests > 0 ? (errors / requests) * 100 : 0,
      saturation: totalSources > 0 ? Math.min(100, (qualified / (totalSources || 1)) * 100) : 0,
      costUsd,
      apiRequests,
      credits,
      dailyBudget: budget("daily_budget_usd"),
      projectBudget: budget("project_budget_usd"),
      hasWorkerData: w.length > 0,
      hasUsageData: (usage ?? []).length > 0,
    },
  };
});

export const getSources = createServerFn({ method: "GET" }).handler(async () => {
  const db = await admin();
  const [sources, candidates, merchants] = await Promise.all([
    db
      .from("sources")
      .select(
        "id, domain, url, source_type, market, status, resolution_status, authority_score, is_official, is_radar, merchant_id, last_scan_at, yield_score, canonical_url, canonical_domain",
      )
      .order("authority_score", { ascending: false })
      .limit(500),
    db
      .from("source_candidates")
      .select(
        "id, domain, url, source_type, market, status, resolution_status, authority_score, is_official, is_radar, merchant_id, last_scan_at, yield_score, canonical_url, canonical_domain",
      )
      .order("discovered_at", { ascending: false })
      .limit(500),
    db.from("merchants").select("id, name"),
  ]);

  const names = new Map((merchants.data ?? []).map((m: any) => [m.id, m.name]));
  const map = (rows: any[], kind: "source" | "candidate") =>
    (rows ?? []).map((r) => ({
      ...r,
      kind,
      merchant: r.merchant_id ? (names.get(r.merchant_id) ?? null) : null,
    }));

  return [...map(sources.data ?? [], "source"), ...map(candidates.data ?? [], "candidate")];
});

export const getQueue = createServerFn({ method: "GET" }).handler(async () => {
  const db = await admin();
  const [jobs, queue] = await Promise.all([
    db
      .from("scan_jobs")
      .select("id, job_type, status, priority, lane, attempts, max_attempts, scheduled_at, started_at, finished_at, error")
      .order("priority", { ascending: true })
      .limit(300),
    db
      .from("scan_queue")
      .select("id, target_url, target_domain, lane, status, priority, locked_by, available_at")
      .order("priority", { ascending: true })
      .limit(300),
  ]);
  return { jobs: jobs.data ?? [], queue: queue.data ?? [] };
});

export const getWorkers = createServerFn({ method: "GET" }).handler(async () => {
  const db = await admin();
  const { data } = await db
    .from("worker_stats")
    .select(
      "id, worker_id, lane, status, last_heartbeat, requests_total, qualified_sources_total, errors_total, rate_403, rate_429, current_job_id",
    )
    .order("last_heartbeat", { ascending: false });
  return data ?? [];
});

export const getApiUsage = createServerFn({ method: "GET" }).handler(async () => {
  const db = await admin();
  const [usage, config] = await Promise.all([
    db
      .from("api_usage")
      .select("id, provider, usage_date, requests, credits, cost_usd")
      .order("usage_date", { ascending: false })
      .limit(300),
    db.from("system_config").select("key, value"),
  ]);
  return { usage: usage.data ?? [], config: config.data ?? [] };
});

export const getConfig = createServerFn({ method: "GET" }).handler(async () => {
  const db = await admin();
  const { data } = await db.from("system_config").select("key, value, description, updated_at").order("key");
  return data ?? [];
});

export const getResolver = createServerFn({ method: "GET" }).handler(async () => {
  const db = await admin();
  const [sources, candidates, edges] = await Promise.all([
    db
      .from("sources")
      .select("id, url, canonical_url, canonical_domain, resolution_status, http_status, verified_at")
      .limit(300),
    db
      .from("source_candidates")
      .select("id, url, canonical_url, canonical_domain, resolution_status, http_status, verified_at")
      .limit(300),
    db
      .from("discovery_edges")
      .select("id, edge_type, discovered_url, final_url, canonical_url, confidence, created_at")
      .order("created_at", { ascending: false })
      .limit(300),
  ]);
  return {
    rows: [...(sources.data ?? []), ...(candidates.data ?? [])],
    edges: edges.data ?? [],
  };
});
