import { createServerFn } from "@tanstack/react-start";

async function admin(): Promise<any> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function getApifyOverview() {
  const token = process.env['APIFY_TOKEN'];
  if (!token) return null;

  const get = async (path: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(`https://api.apify.com/v2${path}`, {
        signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
      if (!res.ok) throw new Error(`Apify ${path} ${res.status}`);
      const payload = await res.json();
      return payload?.data ?? payload;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const [limits, queues, actors] = await Promise.all([
      get("/users/me/limits"),
      get("/request-queues?limit=1000"),
      get("/acts?limit=1000"),
    ]);

    const taskQueue = (queues?.items ?? []).find((q: any) => q.name === "source-scan-native-tasks-v1");
    const masterQueue = (queues?.items ?? []).find((q: any) => q.name === "source-scan-native-master-v1");
    const workerActor = (actors?.items ?? []).find((a: any) => a.name === "source-scan-native-worker");
    const orchestratorActor = (actors?.items ?? []).find((a: any) => a.name === "source-scan-native-orchestrator");

    const [taskInfo, masterInfo, workerRuns, orchestratorRuns] = await Promise.all([
      taskQueue ? get(`/request-queues/${encodeURIComponent(taskQueue.id)}`) : null,
      masterQueue ? get(`/request-queues/${encodeURIComponent(masterQueue.id)}`) : null,
      workerActor ? get(`/acts/${encodeURIComponent(workerActor.id)}/runs?desc=1&limit=100`) : null,
      orchestratorActor ? get(`/acts/${encodeURIComponent(orchestratorActor.id)}/runs?desc=1&limit=20`) : null,
    ]);

    const active = (items: any[] = []) =>
      items.filter((r: any) => r.status === "RUNNING" || r.status === "READY").length;

    return {
      taskTotal: Number(taskInfo?.totalRequestCount ?? 0),
      taskPending: Number(taskInfo?.pendingRequestCount ?? 0),
      taskHandled: Number(taskInfo?.handledRequestCount ?? 0),
      nativeMasterUrls: Number(masterInfo?.totalRequestCount ?? 0),
      activeWorkers: active(workerRuns?.items ?? []),
      activeOrchestrators: active(orchestratorRuns?.items ?? []),
      activeActorJobs: Number(limits?.current?.activeActorJobCount ?? 0),
      maxConcurrentActorJobs: Number(limits?.limits?.maxConcurrentActorJobs ?? 0),
      monthlyUsageUsd: Number(limits?.current?.monthlyUsageUsd ?? 0),
      maxMonthlyUsageUsd: Number(limits?.limits?.maxMonthlyUsageUsd ?? 0),
    };
  } catch {
    return null;
  }
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

  const [candidateSources, officialSourceUrls, totalSourceRows, radarSourceRows, apify] = await Promise.all([
    count("source_candidates"),
    count("sources", (q) => q.eq("is_official", true)),
    count("sources"),
    count("sources", (q) => q.eq("is_radar", true)),
    getApifyOverview(),
  ]);

  const sourceRows: any[] = [];
  const pageSize = 1000;
  for (let offset = 0; offset < 100_000; offset += pageSize) {
    const { data, error } = await db
      .from("sources")
      .select("id, domain, canonical_domain, is_official, is_radar, created_at")
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) break;
    const rows = data ?? [];
    sourceRows.push(...rows);
    if (rows.length < pageSize) break;
  }

  const domainOf = (r: any) => String(r.canonical_domain ?? r.domain ?? "").trim().toLowerCase();
  const masterDomains = new Set<string>();
  const officialDomains = new Set<string>();
  const radarDomains = new Set<string>();
  const newDomainsHour = new Set<string>();
  const hourAgo = Date.now() - 3600_000;

  for (const row of sourceRows) {
    const d = domainOf(row);
    if (!d) continue;
    masterDomains.add(d);
    if (row.is_official) officialDomains.add(d);
    if (row.is_radar) radarDomains.add(d);
    if (row.created_at && new Date(row.created_at).getTime() >= hourAgo) newDomainsHour.add(d);
  }

  const cutoff = new Date(Date.now() - 120_000).toISOString();
  const { data: liveRows } = await db
    .from("worker_stats")
    .select("worker_id, requests_total, qualified_sources_total, errors_total, rate_403, rate_429, last_heartbeat, status")
    .eq("status", "running")
    .gte("last_heartbeat", cutoff);

  const live = liveRows ?? [];
  const workers = live.filter((r: any) => !String(r.worker_id ?? "").startsWith("native-orchestrator-"));
  const orchestrators = live.filter((r: any) => String(r.worker_id ?? "").startsWith("native-orchestrator-"));
  const sum = (rows: any[], k: string) => rows.reduce((a: number, r: any) => a + Number(r[k] ?? 0), 0);
  const avg = (rows: any[], k: string) =>
    rows.length ? rows.reduce((a: number, r: any) => a + Number(r[k] ?? 0), 0) / rows.length : 0;

  const requests = sum(workers, "requests_total");
  const qualified = sum(workers, "qualified_sources_total");
  const errors = sum(workers, "errors_total");

  const { data: recentSources } = await db
    .from("sources")
    .select("id")
    .gte("created_at", new Date(hourAgo).toISOString());

  const activeWorkers = apify?.activeWorkers ?? workers.length;
  const activeOrchestrators = apify?.activeOrchestrators ?? orchestrators.length;
  const masterSourceUrls = apify?.nativeMasterUrls || totalSourceRows;
  const monthlyLimit = apify?.maxMonthlyUsageUsd ?? 0;
  const monthlyUsage = apify?.monthlyUsageUsd ?? 0;

  return {
    kpis: {
      masterDomains: masterDomains.size,
      officialDomains: officialDomains.size,
      masterSourceUrls,
      candidateSources,
      officialSourceUrls,
      radarDomains: radarDomains.size || radarSourceRows,
      nativeQueuePending: apify?.taskPending ?? 0,
      activeWorkers,
    },
    metrics: {
      sourcesPerHour: recentSources?.length ?? 0,
      domainsPerHour: newDomainsHour.size,
      qualifiedPer1k: requests > 0 ? (qualified / requests) * 1000 : 0,
      officialDomainRatio: masterDomains.size > 0 ? (officialDomains.size / masterDomains.size) * 100 : 0,
      rate403: avg(workers, "rate_403"),
      rate429: avg(workers, "rate_429"),
      errorRate: requests > 0 ? (errors / requests) * 100 : 0,
      liveRequests: requests,
      nativeQueueTotal: apify?.taskTotal ?? 0,
      nativeQueueHandled: apify?.taskHandled ?? 0,
      nativeQueuePending: apify?.taskPending ?? 0,
      activeWorkers,
      activeOrchestrators,
      activeActorJobs: apify?.activeActorJobs ?? activeWorkers + activeOrchestrators,
      maxConcurrentActorJobs: apify?.maxConcurrentActorJobs ?? 0,
      monthlyUsageUsd: monthlyUsage,
      maxMonthlyUsageUsd: monthlyLimit,
      monthlyRemainingUsd: monthlyLimit > 0 ? Math.max(0, monthlyLimit - monthlyUsage) : 0,
      monthlyUsagePct: monthlyLimit > 0 ? (monthlyUsage / monthlyLimit) * 100 : 0,
      hasWorkerData: workers.length > 0,
      hasApifyData: Boolean(apify),
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
