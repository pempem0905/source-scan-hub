import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { enqueueSearchQuery, enqueueTarget } from "./queue.server";

export type AutopilotMode = "auto" | "master" | "daily";

const MASTER_QUERIES = [
  '"mã giảm giá" Việt Nam',
  '"voucher" "Việt Nam"',
  '"coupon" "Vietnam"',
  '"khuyến mãi" "Việt Nam"',
  '"ưu đãi" "Việt Nam"',
  '"săn deal" Việt Nam',
  '"deal hot" Việt Nam',
  '"ưu đãi ngân hàng" Việt Nam',
  '"khuyến mãi thẻ" Việt Nam',
  '"promo code" "Vietnam"',
  'inurl:khuyen-mai Việt Nam',
  'inurl:uu-dai Việt Nam',
  'inurl:voucher Việt Nam',
  'inurl:promotion Vietnam',
  'inurl:offers Vietnam',
  'voucher Shopee Việt Nam',
  'voucher Lazada Việt Nam',
  'ưu đãi Grab Việt Nam',
  'khuyến mãi Traveloka Việt Nam',
  'ưu đãi thẻ tín dụng Việt Nam',
  'khuyến mãi siêu thị Việt Nam',
  'khuyến mãi nhà hàng Việt Nam',
  'khuyến mãi mỹ phẩm Việt Nam',
  'khuyến mãi điện máy Việt Nam',
  'khuyến mãi hàng không Việt Nam',
  'khuyến mãi khách sạn Việt Nam',
  'ưu đãi ví điện tử Việt Nam',
  'khuyến mãi viễn thông Việt Nam',
];

const DAILY_QUERIES = [
  '"mã giảm giá" Việt Nam',
  '"voucher" "Việt Nam"',
  '"khuyến mãi" "Việt Nam"',
  '"ưu đãi ngân hàng" Việt Nam',
  '"promo code" "Vietnam"',
  'voucher Shopee Việt Nam',
  'voucher Lazada Việt Nam',
  'ưu đãi thẻ tín dụng Việt Nam',
];

function vnDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function getConfigMap(): Promise<Record<string, unknown>> {
  const { data, error } = await supabaseAdmin.from("system_config").select("key,value");
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((row) => [row.key, row.value]));
}

async function setConfig(key: string, value: unknown, description?: string) {
  const { error } = await supabaseAdmin.from("system_config").upsert(
    {
      key,
      value,
      description: description ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" },
  );
  if (error) throw error;
}

async function recentSearchQueries(cutoffIso: string): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin
    .from("scan_jobs")
    .select("payload,created_at")
    .eq("lane", "SEARCH_DISCOVERY")
    .gte("created_at", cutoffIso);
  if (error) throw error;
  const out = new Set<string>();
  for (const row of data ?? []) {
    const query = (row.payload as { query?: unknown } | null)?.query;
    if (typeof query === "string") out.add(query);
  }
  return out;
}

async function recentQueueDomains(lane: string, cutoffIso: string): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin
    .from("scan_queue")
    .select("target_domain,created_at")
    .eq("lane", lane)
    .gte("created_at", cutoffIso);
  if (error) throw error;
  return new Set((data ?? []).map((r) => r.target_domain).filter(Boolean) as string[]);
}

function countBy<T extends Record<string, any>>(rows: T[], key: keyof T): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const value = String(row[key] ?? "unknown");
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

export async function getAutopilotStats(workerPrefix?: string | null) {
  const today = vnDate();
  const workerQuery = supabaseAdmin
    .from("worker_stats")
    .select("worker_id,lane,status,requests_total,qualified_sources_total,errors_total,rate_403,rate_429,last_heartbeat")
    .gte("last_heartbeat", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
  if (workerPrefix) workerQuery.like("worker_id", `${workerPrefix}%`);

  const [queueRes, sourceRes, candidateRes, workerRes, usageRes, configRes, merchantRes] = await Promise.all([
    supabaseAdmin.from("scan_queue").select("lane,status"),
    supabaseAdmin.from("sources").select("id,domain,source_type,is_radar,is_official"),
    supabaseAdmin.from("source_candidates").select("id,resolution_status,source_type,is_radar,is_official,canonical_domain,domain"),
    workerQuery,
    supabaseAdmin.from("api_usage").select("provider,requests,cost_usd").eq("usage_date", today),
    supabaseAdmin.from("system_config").select("key,value"),
    supabaseAdmin.from("merchants").select("id,status,official_domain"),
  ]);
  for (const res of [queueRes, sourceRes, candidateRes, workerRes, usageRes, configRes, merchantRes]) {
    if (res.error) throw res.error;
  }

  const queue = queueRes.data ?? [];
  const sources = sourceRes.data ?? [];
  const candidates = candidateRes.data ?? [];
  const workers = workerRes.data ?? [];
  const usage = usageRes.data ?? [];
  const merchants = merchantRes.data ?? [];
  const config = Object.fromEntries((configRes.data ?? []).map((r) => [r.key, r.value]));

  const queueByLaneStatus: Record<string, number> = {};
  for (const row of queue) {
    const k = `${row.lane}:${row.status}`;
    queueByLaneStatus[k] = (queueByLaneStatus[k] ?? 0) + 1;
  }

  let workerRequests = 0;
  let workerErrors = 0;
  let weighted403 = 0;
  let weighted429 = 0;
  for (const w of workers) {
    const req = Number(w.requests_total ?? 0);
    workerRequests += req;
    workerErrors += Number(w.errors_total ?? 0);
    weighted403 += req * Number(w.rate_403 ?? 0);
    weighted429 += req * Number(w.rate_429 ?? 0);
  }

  return {
    date: today,
    queueByLaneStatus,
    queueOpen: queue.filter((q) => ["pending", "retry", "running", "paused"].includes(q.status)).length,
    masterSources: sources.length,
    radarSources: sources.filter((s) => s.is_radar).length,
    officialSources: sources.filter((s) => s.is_official).length,
    merchantOfficialSources: sources.filter((s) => s.source_type === "MERCHANT_OFFICIAL").length,
    uniqueSourceDomains: new Set(sources.map((s) => s.domain).filter(Boolean)).size,
    candidates: candidates.length,
    resolvedCandidates: candidates.filter((c) => c.resolution_status === "resolved").length,
    pendingCandidates: candidates.filter((c) => c.resolution_status === "pending").length,
    merchants: merchants.length,
    verifiedMerchants: merchants.filter((m) => m.status === "verified").length,
    workers,
    workerRequests,
    workerErrors,
    workerErrorRate: workerRequests ? (workerErrors / workerRequests) * 100 : 0,
    weighted403: workerRequests ? weighted403 / workerRequests : 0,
    weighted429: workerRequests ? weighted429 / workerRequests : 0,
    apiUsageToday: usage,
    apifyCostToday: usage.filter((u) => u.provider === "apify").reduce((sum, u) => sum + Number(u.cost_usd ?? 0), 0),
    braveRequestsToday: usage.filter((u) => u.provider === "brave").reduce((sum, u) => sum + Number(u.requests ?? 0), 0),
    sourceTypes: countBy(sources, "source_type"),
    candidateResolution: countBy(candidates, "resolution_status"),
    config,
  };
}

export async function prepareAutopilotCycle(requestedMode: AutopilotMode = "auto") {
  const config = await getConfigMap();
  if (config.autopilot_enabled === false) {
    return { shouldRun: false, reason: "autopilot_disabled", mode: requestedMode, stats: await getAutopilotStats() };
  }

  const baselineReady = config.source_baseline_ready === true;
  const mode: "master" | "daily" = requestedMode === "auto" ? (baselineReady ? "daily" : "master") : requestedMode;
  const today = vnDate();
  if (mode === "daily" && config.autopilot_last_daily_date === today) {
    return { shouldRun: false, reason: "daily_already_completed", mode, stats: await getAutopilotStats() };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  await Promise.all([
    setConfig("autopilot_enabled", true, "Autonomous Source Hunter enabled"),
    setConfig("autopilot_mode", mode.toUpperCase(), "MASTER until converged, then DAILY"),
    setConfig("power_mode", "AUTO", "Backend workers are orchestrated by Apify Autopilot"),
    setConfig("global_concurrency", mode === "master" ? 128 : 32),
    setConfig("autopilot_status", "RUNNING"),
  ]);

  // Resume previously paused work after the migration away from Lovable Agent.
  const { error: resumeError } = await supabaseAdmin
    .from("scan_queue")
    .update({ status: "retry", locked_by: null, locked_at: null, available_at: nowIso, updated_at: nowIso })
    .eq("status", "paused");
  if (resumeError) throw resumeError;

  const queryIntervalMs = mode === "master" ? 8 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const recentQueries = await recentSearchQueries(new Date(Date.now() - queryIntervalMs).toISOString());
  const queries = mode === "master" ? MASTER_QUERIES : DAILY_QUERIES;
  let searchSeeded = 0;
  for (const query of queries) {
    if (recentQueries.has(query)) continue;
    await enqueueSearchQuery({ query, priority: mode === "master" ? 80 : 100 });
    searchSeeded += 1;
  }

  // Re-expand verified radar roots, but not more often than the cycle interval.
  const expandIntervalMs = mode === "master" ? 6 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const recentExpanded = await recentQueueDomains("DOMAIN_EXPANDER", new Date(Date.now() - expandIntervalMs).toISOString());
  const { data: radarRows, error: radarError } = await supabaseAdmin
    .from("sources")
    .select("domain,url,canonical_url")
    .eq("is_radar", true)
    .eq("status", "verified");
  if (radarError) throw radarError;
  const seenRadar = new Set<string>();
  let radarSeeded = 0;
  for (const row of radarRows ?? []) {
    const domain = row.domain?.toLowerCase();
    if (!domain || seenRadar.has(domain) || recentExpanded.has(domain)) continue;
    seenRadar.add(domain);
    const url = row.canonical_url ?? row.url;
    if (!url) continue;
    await enqueueTarget({ targetUrl: url, lane: "DOMAIN_EXPANDER", priority: 90 });
    radarSeeded += 1;
  }

  // Any newly discovered unresolved candidate gets an origin-resolution target.
  const { data: pendingCandidates, error: pendingError } = await supabaseAdmin
    .from("source_candidates")
    .select("url,discovered_via")
    .eq("resolution_status", "pending")
    .neq("discovered_via", "smoke_test")
    .limit(mode === "master" ? 1000 : 300);
  if (pendingError) throw pendingError;
  let resolverSeeded = 0;
  for (const candidate of pendingCandidates ?? []) {
    if (!candidate.url) continue;
    await enqueueTarget({ targetUrl: candidate.url, lane: "ORIGIN_RESOLVER", priority: 100 });
    resolverSeeded += 1;
  }

  // Sitemap/promo-path checks are cheap and run less frequently than resolver work.
  const sourceProbeIntervalMs = mode === "master" ? 12 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const probeCutoff = new Date(Date.now() - sourceProbeIntervalMs).toISOString();
  const [recentSitemap, recentPromo] = await Promise.all([
    recentQueueDomains("SITEMAP_HUNTER", probeCutoff),
    recentQueueDomains("PROMO_PATH_HUNTER", probeCutoff),
  ]);
  const { data: verifiedSources, error: verifiedError } = await supabaseAdmin
    .from("sources")
    .select("domain,url,canonical_url")
    .eq("status", "verified")
    .limit(mode === "master" ? 500 : 200);
  if (verifiedError) throw verifiedError;
  let sitemapSeeded = 0;
  let promoSeeded = 0;
  const seenProbe = new Set<string>();
  for (const row of verifiedSources ?? []) {
    const domain = row.domain?.toLowerCase();
    const url = row.canonical_url ?? row.url;
    if (!domain || !url || seenProbe.has(domain)) continue;
    seenProbe.add(domain);
    if (!recentSitemap.has(domain)) {
      await enqueueTarget({ targetUrl: url, lane: "SITEMAP_HUNTER", priority: 130 });
      sitemapSeeded += 1;
    }
    if (!recentPromo.has(domain)) {
      await enqueueTarget({ targetUrl: url, lane: "PROMO_PATH_HUNTER", priority: 140 });
      promoSeeded += 1;
    }
  }

  const stats = await getAutopilotStats();
  return {
    shouldRun: true,
    mode,
    sourceCountBefore: stats.masterSources,
    seeded: { searchSeeded, radarSeeded, resolverSeeded, sitemapSeeded, promoSeeded },
    stats,
  };
}

export async function finishAutopilotCycle(input: {
  mode: "master" | "daily";
  sourceCountBefore: number;
  workerPrefix?: string | null;
  apifyCostUsd?: number;
}) {
  const stats = await getAutopilotStats(input.workerPrefix);
  const delta = Math.max(0, stats.masterSources - Math.max(0, input.sourceCountBefore));
  const config = await getConfigMap();
  const oldStreak = Number(config.autopilot_low_growth_streak ?? 0);
  const lowGrowthThreshold = Math.max(2, Math.floor(Math.max(1, input.sourceCountBefore) * 0.005));
  const lowGrowth = delta <= lowGrowthThreshold;
  const streak = lowGrowth ? oldStreak + 1 : 0;
  const baselineReady = input.mode === "master" && stats.masterSources >= 250 && streak >= 3;

  await Promise.all([
    setConfig("autopilot_last_run_at", new Date().toISOString()),
    setConfig("autopilot_last_delta", delta),
    setConfig("autopilot_low_growth_streak", streak),
    setConfig("autopilot_status", "IDLE"),
    input.mode === "daily" ? setConfig("autopilot_last_daily_date", vnDate()) : Promise.resolve(),
    baselineReady ? setConfig("source_baseline_ready", true, "Three consecutive low-growth master cycles") : Promise.resolve(),
    baselineReady ? setConfig("autopilot_mode", "DAILY") : Promise.resolve(),
  ]);

  const { error: eventError } = await supabaseAdmin.from("source_events").insert({
    event_type: "autopilot_cycle",
    payload: {
      mode: input.mode,
      sourceCountBefore: input.sourceCountBefore,
      sourceCountAfter: stats.masterSources,
      delta,
      lowGrowthThreshold,
      lowGrowthStreak: streak,
      baselineReady,
      apifyCostUsd: input.apifyCostUsd ?? 0,
      worker403: stats.weighted403,
      worker429: stats.weighted429,
      workerErrorRate: stats.workerErrorRate,
    },
  });
  if (eventError) throw eventError;

  return { delta, streak, baselineReady, stats };
}
