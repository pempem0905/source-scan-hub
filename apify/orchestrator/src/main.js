import { Actor, log } from "apify";

const APIFY_BASE = "https://api.apify.com/v2";
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const input = (await Actor.getInput()) ?? {};
  const hubBaseUrl = String(input.hubBaseUrl ?? "").replace(/\/$/, "");
  const workerToken = String(input.workerToken ?? "");
  const workerActorId = String(input.workerActorId ?? "");
  const requestedMode = String(input.mode ?? "auto");
  const maxResolverWorkers = Math.max(4, Math.min(32, Number(input.maxResolverWorkers ?? 16)));
  const maxCycleSpendUsd = Math.max(0.01, Number(input.maxCycleSpendUsd ?? 0.2));
  const maxCycleMinutes = Math.max(5, Math.min(120, Number(input.maxCycleMinutes ?? 45)));
  const apifyToken = process.env.APIFY_TOKEN;
  const runId = Actor.getEnv().actorRunId ?? String(Date.now());
  const workerPrefix = `autopilot-${runId}`;
  const startedAt = Date.now();

  if (!hubBaseUrl || !workerToken || !workerActorId) {
    throw new Error("hubBaseUrl, workerToken and workerActorId are required");
  }
  if (!apifyToken) throw new Error("APIFY_TOKEN is not available in the Actor runtime");

  async function hub(path, body) {
    const res = await fetch(`${hubBaseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { error: text }; }
    if (!res.ok || payload?.ok === false) {
      throw new Error(`Hub ${path} failed ${res.status}: ${payload?.error ?? text}`);
    }
    return payload.result ?? payload;
  }

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
    try { payload = JSON.parse(text); } catch { payload = { error: text }; }
    if (!res.ok) throw new Error(`Apify API ${path} failed ${res.status}: ${text.slice(0, 500)}`);
    return payload.data ?? payload;
  }

  function openCount(stats, lane) {
    const q = stats?.queueByLaneStatus ?? {};
    return Number(q[`${lane}:pending`] ?? 0) + Number(q[`${lane}:retry`] ?? 0);
  }

  let cycleCost = 0;
  let childRuns = 0;
  const launched = [];

  async function recordBatchCost(cost, runs) {
    if (cost <= 0 && runs <= 0) return;
    await hub("/api/source-engine/usage", {
      provider: "apify",
      requests: runs,
      costUsd: cost,
    });
  }

  async function startWorker(lane, index, maxItems) {
    const workerId = `${workerPrefix}-${lane}-${index}`;
    const params = new URLSearchParams({ memory: "256", timeout: "900", build: "latest" });
    const data = await apify(`/acts/${encodeURIComponent(workerActorId)}/runs?${params.toString()}`, {
      method: "POST",
      body: JSON.stringify({
        hubBaseUrl,
        workerToken,
        lane,
        workerId,
        maxItems,
        idlePollMs: 1500,
        emptyPollLimit: 3,
      }),
    });
    childRuns += 1;
    launched.push({ id: data.id, lane, workerId });
    return data.id;
  }

  async function waitRuns(runIds, timeoutMs = 16 * 60 * 1000) {
    const deadline = Date.now() + timeoutMs;
    const done = new Map();
    while (done.size < runIds.length && Date.now() < deadline) {
      for (const id of runIds) {
        if (done.has(id)) continue;
        const run = await apify(`/actor-runs/${encodeURIComponent(id)}`);
        if (TERMINAL.has(run.status)) done.set(id, run);
      }
      if (done.size < runIds.length) await sleep(5000);
    }
    let cost = 0;
    for (const id of runIds) {
      const run = done.get(id) ?? await apify(`/actor-runs/${encodeURIComponent(id)}`);
      cost += Number(run.usageTotalUsd ?? 0);
      if (run.status !== "SUCCEEDED") log.warning("Child worker did not succeed", { id, status: run.status });
    }
    cycleCost += cost;
    await recordBatchCost(cost, runIds.length);
    return { cost, done: [...done.values()] };
  }

  function timeRemaining() {
    return Date.now() - startedAt < maxCycleMinutes * 60 * 1000;
  }

  const prepared = await hub("/api/autopilot", { action: "prepare", mode: requestedMode });
  if (!prepared.shouldRun) {
    log.info("Autopilot no-op", { reason: prepared.reason, mode: prepared.mode });
    await Actor.pushData({ status: "NOOP", reason: prepared.reason, mode: prepared.mode, stats: prepared.stats });
    return;
  }

  const mode = prepared.mode;
  const sourceCountBefore = Number(prepared.sourceCountBefore ?? prepared.stats?.masterSources ?? 0);
  const dailyBudget = Number(prepared.stats?.config?.daily_budget_usd ?? 1);
  const alreadySpent = Number(prepared.stats?.apifyCostToday ?? 0);
  const cycleBudget = Math.max(0, Math.min(maxCycleSpendUsd, dailyBudget - alreadySpent));

  if (cycleBudget <= 0) {
    log.warning("Daily Apify budget already exhausted", { dailyBudget, alreadySpent });
    const final = await hub("/api/autopilot", {
      action: "finish",
      mode,
      sourceCountBefore,
      workerPrefix,
      apifyCostUsd: 0,
    });
    await Actor.pushData({ status: "BUDGET_STOP", mode, final });
    return;
  }

  const canLaunch = () => timeRemaining() && cycleCost < cycleBudget;

  async function runLane(lane, maxWorkers, maxItemsPerWorker = 120) {
    if (!canLaunch()) return 0;
    const stats = await hub("/api/autopilot", { action: "stats" });
    const open = openCount(stats, lane);
    if (open <= 0) return 0;
    const workers = Math.max(1, Math.min(maxWorkers, open));
    const perWorker = Math.max(5, Math.min(maxItemsPerWorker, Math.ceil(open / workers) + 5));
    const ids = [];
    for (let i = 0; i < workers && canLaunch(); i += 1) {
      ids.push(await startWorker(lane, `${Date.now()}-${i + 1}`, perWorker));
    }
    if (ids.length) await waitRuns(ids);
    return ids.length;
  }

  // Search and radar expansion are deliberately separated from resolution.
  await runLane("SEARCH_DISCOVERY", 1, mode === "master" ? 40 : 12);
  await hub("/api/autopilot", { action: "prepare", mode });
  await runLane("DOMAIN_EXPANDER", mode === "master" ? 2 : 1, 100);
  await hub("/api/autopilot", { action: "prepare", mode });

  // Resolver starts conservatively at 4 and adapts only when the live rates are healthy.
  let resolverWorkers = 4;
  let resolverRound = 0;
  while (canLaunch()) {
    const stats = await hub("/api/autopilot", { action: "stats" });
    const open = openCount(stats, "ORIGIN_RESOLVER");
    if (open <= 0) break;
    resolverRound += 1;
    const workers = Math.min(resolverWorkers, open);
    const perWorker = Math.max(10, Math.min(150, Math.ceil(open / workers) + 8));
    const ids = [];
    for (let i = 0; i < workers && canLaunch(); i += 1) {
      ids.push(await startWorker("ORIGIN_RESOLVER", `r${resolverRound}-${i + 1}`, perWorker));
    }
    if (!ids.length) break;
    await waitRuns(ids);

    const resolverStats = await hub("/api/autopilot", {
      action: "stats",
      workerPrefix: `${workerPrefix}-ORIGIN_RESOLVER-`,
    });
    const healthy =
      Number(resolverStats.weighted403 ?? 0) < 5 &&
      Number(resolverStats.weighted429 ?? 0) < 3 &&
      Number(resolverStats.workerErrorRate ?? 0) < 5;
    resolverWorkers = healthy ? Math.min(maxResolverWorkers, resolverWorkers * 2) : 4;
    if (!healthy) log.info("Resolver held at 4 due to live error gates", {
      rate403: resolverStats.weighted403,
      rate429: resolverStats.weighted429,
      errorRate: resolverStats.workerErrorRate,
    });
  }

  // Cheap source-path probes run after primary origin resolution.
  if (canLaunch()) await runLane("SITEMAP_HUNTER", mode === "master" ? 2 : 1, 80);
  if (canLaunch()) await runLane("PROMO_PATH_HUNTER", mode === "master" ? 2 : 1, 80);
  if (canLaunch()) {
    await hub("/api/autopilot", { action: "prepare", mode });
    await runLane("ORIGIN_RESOLVER", 4, 100);
  }

  const final = await hub("/api/autopilot", {
    action: "finish",
    mode,
    sourceCountBefore,
    workerPrefix,
    apifyCostUsd: cycleCost,
  });

  const output = {
    status: "COMPLETED",
    mode,
    childRuns,
    cycleCostUsd: cycleCost,
    cycleBudgetUsd: cycleBudget,
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    sourceCountBefore,
    sourceCountAfter: final?.stats?.masterSources,
    sourceDelta: final?.delta,
    baselineReady: final?.baselineReady,
    lowGrowthStreak: final?.streak,
    queueOpen: final?.stats?.queueOpen,
    resolver403: final?.stats?.weighted403,
    resolver429: final?.stats?.weighted429,
    workerErrorRate: final?.stats?.workerErrorRate,
    launched,
  };
  await Actor.pushData(output);
  log.info("Source Scan Hub Autopilot cycle complete", output);
}

await Actor.main(main);
