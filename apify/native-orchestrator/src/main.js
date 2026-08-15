import { Actor, log } from "apify";

const APIFY_BASE = "https://api.apify.com/v2";
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);
const DEFAULT_SEEDS = [
  "https://bloggiamgia.vn/",
  "https://www.picodi.com/vn/",
  "https://shopee.vn/",
  "https://www.lazada.vn/",
  "https://tiki.vn/",
  "https://www.grab.com/vn/",
  "https://www.traveloka.com/vi-vn/",
  "https://www.vietcombank.com.vn/",
  "https://techcombank.com/",
  "https://www.vpbank.com.vn/",
  "https://www.acb.com.vn/",
  "https://www.sacombank.com.vn/",
  "https://www.mbbank.com.vn/",
  "https://www.vib.com.vn/",
  "https://www.hdbank.com.vn/",
  "https://www.ocb.com.vn/",
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hostOf(raw) {
  try { return new URL(raw).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}
function normalizeUrl(raw) {
  const u = new URL(raw);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  for (const key of [...u.searchParams.keys()]) {
    const k = key.toLowerCase();
    if (k.startsWith("utm_") || ["gclid", "fbclid", "clickid", "click_id", "aff", "aff_id", "affiliate_id", "subid", "sub_id"].includes(k)) u.searchParams.delete(key);
  }
  return u.toString();
}
function rootOf(raw) {
  const u = new URL(raw);
  return `${u.protocol}//${u.host}/`;
}
function vnDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

await Actor.main(async () => {
  const input = (await Actor.getInput()) ?? {};
  const workerActorId = String(input.workerActorId ?? "");
  const taskQueueName = String(input.taskQueueName ?? "source-scan-native-tasks-v1");
  const masterQueueName = String(input.masterQueueName ?? "source-scan-native-master-v1");
  const masterDatasetName = String(input.masterDatasetName ?? "source-scan-native-master-events-v1");
  const evidenceDatasetName = String(input.evidenceDatasetName ?? "source-scan-native-evidence-v1");
  const runtimeStoreName = String(input.runtimeStoreName ?? "source-scan-native-runtime-v1");
  const localConcurrency = Math.max(1, Math.min(24, Number(input.localConcurrency ?? 10)));
  const maxWorkerItems = Math.max(1, Math.min(5000, Number(input.maxWorkerItems ?? 600)));
  const maxWorkerRunMinutes = Math.max(2, Math.min(120, Number(input.maxWorkerRunMinutes ?? 20)));
  const maxCycleMinutes = Math.max(5, Math.min(180, Number(input.maxCycleMinutes ?? 50)));
  const dailyBudgetUsd = Math.max(0.01, Number(input.dailyBudgetUsd ?? 1));
  const projectBudgetUsd = Math.max(1, Number(input.projectBudgetUsd ?? 50));
  const requestedMode = String(input.mode ?? "auto").toLowerCase();
  const displayBaseUrl = String(input.displayBaseUrl ?? "").replace(/\/$/, "");
  const displayToken = String(input.displayToken ?? "");
  const bootstrapSources = Array.isArray(input.bootstrapSources) ? input.bootstrapSources : [];
  const bootstrapCandidates = Array.isArray(input.bootstrapCandidates) ? input.bootstrapCandidates : [];
  const seedUrls = [...DEFAULT_SEEDS, ...(Array.isArray(input.seedUrls) ? input.seedUrls : [])];
  const apifyToken = process.env.APIFY_TOKEN;
  const runId = Actor.getEnv().actorRunId ?? String(Date.now());
  const startedAt = Date.now();
  const deadline = startedAt + maxCycleMinutes * 60_000;

  if (!workerActorId) throw new Error("workerActorId is required");
  if (!apifyToken) throw new Error("APIFY_TOKEN is unavailable in the Actor runtime");

  const taskQueue = await Actor.openRequestQueue(taskQueueName);
  const masterQueue = await Actor.openRequestQueue(masterQueueName);
  const masterDataset = await Actor.openDataset(masterDatasetName);
  const runtimeStore = await Actor.openKeyValueStore(runtimeStoreName);

  async function apify(path, init = {}) {
    const res = await fetch(`${APIFY_BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${apifyToken}`,
        accept: "application/json",
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    if (!res.ok) throw new Error(`Apify API ${path} failed ${res.status}: ${text.slice(0, 500)}`);
    return payload.data ?? payload;
  }

  async function display(path, body) {
    if (!displayBaseUrl || !displayToken) return;
    try {
      await fetch(`${displayBaseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${displayToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {}
  }

  const oldLease = await runtimeStore.getValue("LEASE").catch(() => null);
  if (oldLease?.expiresAt && new Date(oldLease.expiresAt).getTime() > Date.now() && oldLease.runId !== runId) {
    log.info("Another native orchestrator holds the lease", oldLease);
    await Actor.pushData({ status: "NOOP", reason: "lease_held", lease: oldLease });
    return;
  }
  await runtimeStore.setValue("LEASE", { runId, startedAt: new Date().toISOString(), expiresAt: new Date(deadline + 5 * 60_000).toISOString() });

  let state = (await runtimeStore.getValue("STATE").catch(() => null)) ?? { mode: "master", baselineReady: false, lowGrowthStreak: 0, lastDailyDate: null };
  let budget = (await runtimeStore.getValue("BUDGET").catch(() => null)) ?? { date: vnDate(), dailySpentUsd: 0, projectSpentUsd: 0 };
  const today = vnDate();
  if (budget.date !== today) budget = { ...budget, date: today, dailySpentUsd: 0 };

  let mode = requestedMode === "master" || requestedMode === "daily" ? requestedMode : (state.mode ?? "master");
  if (mode === "daily" && state.lastDailyDate === today) {
    await runtimeStore.setValue("LEASE", { runId, releasedAt: new Date().toISOString(), expiresAt: new Date().toISOString() });
    await Actor.pushData({ status: "NOOP", reason: "daily_already_completed", mode, today });
    return;
  }

  if (budget.dailySpentUsd >= dailyBudgetUsd || budget.projectSpentUsd >= projectBudgetUsd) {
    await runtimeStore.setValue("LEASE", { runId, releasedAt: new Date().toISOString(), expiresAt: new Date().toISOString() });
    await Actor.pushData({ status: "BUDGET_STOP", mode, budget, dailyBudgetUsd, projectBudgetUsd });
    return;
  }

  async function addTask(kind, rawUrl, data = {}, uniquePrefix = "") {
    try {
      const normalized = normalizeUrl(rawUrl);
      const uniqueKey = `${uniquePrefix}${kind}:${normalized}`;
      return taskQueue.addRequest({ url: normalized, uniqueKey, userData: { kind, ...data } });
    } catch { return null; }
  }

  async function seedRoot(rawUrl, fromRadar = false, via = "seed", uniquePrefix = "") {
    let root;
    try { root = rootOf(rawUrl); } catch { return; }
    await addTask("RESOLVE", rawUrl, { discoveredVia: via, discoveredFrom: rawUrl, fromRadar }, uniquePrefix);
    await addTask("DOMAIN_EXPAND", root, { discoveredVia: via, fromRadar }, uniquePrefix);
    await addTask("SITEMAP", root, { discoveredVia: via, fromRadar }, uniquePrefix);
    await addTask("PROMO_PATH", root, { discoveredVia: via, fromRadar }, uniquePrefix);
    await addTask("CC_LOOKUP", root, { discoveredVia: via, fromRadar }, uniquePrefix);
  }

  async function bootstrapOnce() {
    const already = await runtimeStore.getValue("BOOTSTRAPPED").catch(() => null);
    if (already && bootstrapSources.length === 0 && bootstrapCandidates.length === 0) return already;
    let importedSources = 0;
    let importedCandidates = 0;
    for (const row of bootstrapSources.slice(0, 5000)) {
      const raw = row?.canonical_url ?? row?.url;
      if (!raw) continue;
      try {
        const normalized = normalizeUrl(raw);
        const sourceType = row?.source_type ?? "OTHER";
        const result = await masterQueue.addRequest({
          url: normalized,
          uniqueKey: `source:${normalized}`,
          userData: {
            sourceType,
            domain: row?.canonical_domain ?? row?.domain ?? hostOf(normalized),
            discoveredVia: row?.discovered_via ?? "lovable_migration",
            authorityScore: row?.authority_score ?? 10,
            market: row?.market ?? "VN",
            migrated: true,
          },
        });
        if (!result.wasAlreadyPresent && !result.wasAlreadyHandled) {
          importedSources += 1;
          await masterDataset.pushData({ event: "MASTER_SOURCE_MIGRATED", at: new Date().toISOString(), url: normalized, domain: hostOf(normalized), sourceType, discoveredVia: "lovable_migration" });
        }
        await seedRoot(normalized, Boolean(row?.is_radar), "migrated_source");
      } catch {}
    }
    for (const row of bootstrapCandidates.slice(0, 10000)) {
      const raw = row?.canonical_url ?? row?.url;
      if (!raw) continue;
      await seedRoot(raw, Boolean(row?.is_radar), "migrated_candidate");
      importedCandidates += 1;
    }
    for (const url of seedUrls) await seedRoot(url, /bloggiamgia|picodi|giamgia|coupon|voucher/i.test(url), "curated_seed");
    const record = { at: new Date().toISOString(), importedSources, importedCandidates, curatedSeeds: seedUrls.length };
    await runtimeStore.setValue("BOOTSTRAPPED", record);
    return record;
  }

  async function seedDaily() {
    const prefix = `DAILY:${today}:`;
    const page = await masterDataset.getData({ offset: 0, limit: 5000, desc: true }).catch(() => ({ items: [] }));
    const seen = new Set();
    let seeded = 0;
    for (const item of page.items ?? []) {
      const url = item?.url;
      if (!url) continue;
      const normalized = normalizeUrl(url);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      await seedRoot(normalized, /AFFILIATE|COUPON|DEAL|BLOG/.test(String(item?.sourceType ?? "")), "daily_refresh", prefix);
      seeded += 1;
    }
    return seeded;
  }

  const beforeInfo = await masterQueue.getInfo().catch(() => null);
  const beforeMaster = Number(beforeInfo?.totalRequestCount ?? 0);
  const bootstrap = await bootstrapOnce();
  let dailySeeded = 0;
  if (mode === "daily") dailySeeded = await seedDaily();

  let cycleCost = 0;
  let launchedRuns = 0;
  let batches = 0;
  const launched = [];

  async function limits() {
    return apify("/users/me/limits");
  }

  async function publishStatus(extra = {}) {
    const l = await limits().catch(() => null);
    const taskInfo = await taskQueue.getInfo().catch(() => null);
    const masterInfo = await masterQueue.getInfo().catch(() => null);
    const status = {
      runId, mode, at: new Date().toISOString(),
      maxConcurrentActorJobs: l?.limits?.maxConcurrentActorJobs ?? null,
      activeActorJobs: l?.current?.activeActorJobCount ?? null,
      taskQueue: taskInfo ? { total: taskInfo.totalRequestCount, pending: taskInfo.pendingRequestCount, handled: taskInfo.handledRequestCount } : null,
      masterSources: masterInfo?.totalRequestCount ?? null,
      cycleCostUsd: cycleCost,
      budget,
      localConcurrency,
      ...extra,
    };
    await runtimeStore.setValue("STATUS", status).catch(() => {});
    await display("/api/source-engine/heartbeat", {
      workerId: `native-orchestrator-${runId}`,
      lane: "CLASSIFIER_DEDUPER",
      status: extra.finished ? "idle" : "running",
      requestsTotal: launchedRuns,
      qualifiedSourcesTotal: Math.max(0, Number(status.masterSources ?? 0) - beforeMaster),
      errorsTotal: 0,
      rate403: 0,
      rate429: 0,
    });
    return status;
  }

  async function startWorker(index) {
    const workerId = `${runId}-${batches}-${index}`;
    const params = new URLSearchParams({ memory: "256", timeout: String(maxWorkerRunMinutes * 60 + 120), build: "latest" });
    const run = await apify(`/acts/${encodeURIComponent(workerActorId)}/runs?${params.toString()}`, {
      method: "POST",
      body: JSON.stringify({
        workerId,
        taskQueueName,
        masterQueueName,
        masterDatasetName,
        evidenceDatasetName,
        runtimeStoreName,
        localConcurrency,
        maxItems: maxWorkerItems,
        maxRunMinutes: maxWorkerRunMinutes,
        displayBaseUrl,
        displayToken,
      }),
    });
    launchedRuns += 1;
    launched.push(run.id);
    return run.id;
  }

  async function waitBatch(runIds) {
    const done = new Map();
    while (done.size < runIds.length && Date.now() < deadline) {
      for (const id of runIds) {
        if (done.has(id)) continue;
        const run = await apify(`/actor-runs/${encodeURIComponent(id)}`);
        if (TERMINAL.has(run.status)) done.set(id, run);
      }
      if (done.size < runIds.length) {
        await publishStatus({ batch: batches, batchRunning: runIds.length - done.size }).catch(() => {});
        await sleep(7000);
      }
    }
    await sleep(2500);
    let cost = 0;
    for (const id of runIds) {
      const run = done.get(id) ?? await apify(`/actor-runs/${encodeURIComponent(id)}`);
      cost += Number(run.usageTotalUsd ?? 0);
    }
    cycleCost += cost;
    budget.dailySpentUsd += cost;
    budget.projectSpentUsd += cost;
    await runtimeStore.setValue("BUDGET", budget);
    if (cost > 0) await display("/api/source-engine/usage", { provider: "apify_native", requests: runIds.length, costUsd: cost });
    return cost;
  }

  await publishStatus({ bootstrap, dailySeeded });

  while (Date.now() < deadline) {
    const taskInfo = await taskQueue.getInfo().catch(() => null);
    const pending = Number(taskInfo?.pendingRequestCount ?? 0);
    if (pending <= 0) break;
    const l = await limits();
    const maxJobs = Number(l?.limits?.maxConcurrentActorJobs ?? 1);
    const active = Number(l?.current?.activeActorJobCount ?? 1);
    const freeSlots = Math.max(0, maxJobs - active);
    if (freeSlots <= 0) { await sleep(5000); continue; }

    const dailyRemaining = Math.max(0, dailyBudgetUsd - budget.dailySpentUsd);
    const projectRemaining = Math.max(0, projectBudgetUsd - budget.projectSpentUsd);
    const remaining = Math.min(dailyRemaining, projectRemaining);
    if (remaining <= 0.001) break;

    // Conservative $0.20/CU estimate keeps the existing $1/day and $50/project guards.
    const estimatedWorkerMaxCost = 0.256 * (maxWorkerRunMinutes / 60) * 0.20;
    const budgetSlots = Math.max(1, Math.floor(remaining / Math.max(estimatedWorkerMaxCost, 0.001)));
    const slots = Math.max(0, Math.min(freeSlots, pending, budgetSlots));
    if (slots <= 0) break;

    batches += 1;
    const ids = [];
    for (let i = 0; i < slots && Date.now() < deadline; i += 1) ids.push(await startWorker(i + 1));
    await publishStatus({ batch: batches, batchLaunched: ids.length, freeSlotsBefore: freeSlots, maxJobs });
    if (!ids.length) break;
    await waitBatch(ids);
    if (budget.dailySpentUsd >= dailyBudgetUsd || budget.projectSpentUsd >= projectBudgetUsd) break;
  }

  const afterInfo = await masterQueue.getInfo().catch(() => null);
  const taskAfter = await taskQueue.getInfo().catch(() => null);
  const afterMaster = Number(afterInfo?.totalRequestCount ?? beforeMaster);
  const delta = Math.max(0, afterMaster - beforeMaster);
  const growthRate = beforeMaster > 0 ? delta / beforeMaster : (delta > 0 ? 1 : 0);
  const lowGrowth = growthRate < 0.01 || delta < 3;
  state.lowGrowthStreak = lowGrowth ? Number(state.lowGrowthStreak ?? 0) + 1 : 0;
  if (mode === "master" && Number(taskAfter?.pendingRequestCount ?? 0) === 0 && state.lowGrowthStreak >= 3) {
    state.baselineReady = true;
    state.mode = "daily";
  } else if (!state.mode) state.mode = mode;
  if (mode === "daily") state.lastDailyDate = today;
  state.lastRunAt = new Date().toISOString();
  state.lastMasterCount = afterMaster;
  state.lastDelta = delta;
  state.lastGrowthRate = growthRate;
  await runtimeStore.setValue("STATE", state);

  const finalStatus = await publishStatus({
    finished: true,
    batches,
    launchedRuns,
    beforeMaster,
    afterMaster,
    delta,
    growthRate,
    lowGrowthStreak: state.lowGrowthStreak,
    baselineReady: state.baselineReady,
  });
  await runtimeStore.setValue("LEASE", { runId, releasedAt: new Date().toISOString(), expiresAt: new Date().toISOString() });

  const output = {
    status: "COMPLETED",
    mode,
    nextMode: state.mode,
    accountMaxConcurrentRuns: finalStatus.maxConcurrentActorJobs,
    launchedRuns,
    batches,
    localConcurrency,
    effectiveNetworkConcurrencyTarget: launchedRuns ? Math.min(finalStatus.maxConcurrentActorJobs ?? launchedRuns, launchedRuns) * localConcurrency : 0,
    cycleCostUsd: cycleCost,
    budget,
    beforeMaster,
    afterMaster,
    delta,
    growthRate,
    queuePending: finalStatus.taskQueue?.pending ?? null,
    baselineReady: state.baselineReady,
    lowGrowthStreak: state.lowGrowthStreak,
    bootstrap,
    dailySeeded,
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
  };
  await Actor.pushData(output);
  log.info("Native orchestrator complete", output);
});
