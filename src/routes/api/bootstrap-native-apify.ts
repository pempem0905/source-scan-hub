import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const BOOTSTRAP_TOKEN = "vKd5jIOoKvbcGSy7zWi0-LOVDXVNVjtU6RoHOq2z9oM";
const APIFY_BASE = "https://api.apify.com/v2";
const DISPLAY_BASE_URL = "https://source-scan-hub.lovable.app";

const fileSchema = z.object({
  name: z.string().min(1).max(300),
  format: z.literal("TEXT").default("TEXT"),
  content: z.string().max(700_000),
});

function secret(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing from server secrets`);
  return value;
}

async function apifyRaw(path: string, init: RequestInit = {}) {
  return fetch(`${APIFY_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${secret("APIFY_TOKEN")}`,
      accept: "application/json",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function apify(path: string, init: RequestInit = {}) {
  const res = await apifyRaw(path, init);
  const text = await res.text();
  let payload: any;
  try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
  if (!res.ok) throw new Error(`Apify ${path} failed ${res.status}: ${text.slice(0, 1800)}`);
  return payload.data ?? payload;
}

async function apifyText(path: string) {
  const res = await apifyRaw(path);
  const text = await res.text();
  if (!res.ok) throw new Error(`Apify ${path} failed ${res.status}: ${text.slice(0, 1200)}`);
  return text;
}

async function waitBuild(buildId: string) {
  const deadline = Date.now() + 7 * 60_000;
  while (Date.now() < deadline) {
    const build = await apify(`/actor-builds/${encodeURIComponent(buildId)}`);
    if (["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(build.status)) return build;
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  throw new Error(`Timed out waiting for build ${buildId}`);
}

async function actors() {
  const list = await apify("/acts?limit=1000");
  const worker = (list.items ?? []).find((a: any) => a.name === "source-scan-native-worker");
  const orchestrator = (list.items ?? []).find((a: any) => a.name === "source-scan-native-orchestrator");
  if (!worker || !orchestrator) throw new Error("Native Actors are missing");
  return { worker, orchestrator };
}

async function buildActor(actorId: string, files: z.infer<typeof fileSchema>[], envVars: Array<{ name: string; value: string; isSecret?: boolean }> = []) {
  const version = { versionNumber: "1.0", buildTag: "latest", sourceType: "SOURCE_FILES", sourceFiles: files, envVars };
  await apify(`/acts/${encodeURIComponent(actorId)}/versions/1.0`, { method: "PUT", body: JSON.stringify(version) });
  const build = await apify(`/acts/${encodeURIComponent(actorId)}/builds?version=1.0&tag=latest`, { method: "POST" });
  const finished = await waitBuild(build.id);
  if (finished.status !== "SUCCEEDED") {
    const logTail = (await apifyText(`/logs/${encodeURIComponent(build.id)}`).catch(() => "")).slice(-8000);
    throw new Error(`Build ${build.id} ended ${finished.status}; ${logTail}`);
  }
  return finished;
}

async function inspect(runId?: string) {
  const { worker, orchestrator } = await actors();
  const [limits, workerRuns, orchestratorRuns, stores] = await Promise.all([
    apify("/users/me/limits"),
    apify(`/acts/${encodeURIComponent(worker.id)}/runs?desc=1&limit=100`),
    apify(`/acts/${encodeURIComponent(orchestrator.id)}/runs?desc=1&limit=20`),
    apify("/key-value-stores?limit=1000"),
  ]);
  const runtimeStore = (stores.items ?? []).find((s: any) => s.name === "source-scan-native-runtime-v1");
  const readRecord = async (key: string) => runtimeStore ? apify(`/key-value-stores/${runtimeStore.id}/records/${key}`).catch(() => null) : null;
  const [status, state, budget, lease] = await Promise.all([readRecord("STATUS"), readRecord("STATE"), readRecord("BUDGET"), readRecord("LEASE")]);
  const targetRun = runId ? await apify(`/actor-runs/${encodeURIComponent(runId)}`).catch(() => null) : null;
  const items = workerRuns.items ?? [];
  return {
    limits: {
      maxConcurrentActorJobs: limits?.limits?.maxConcurrentActorJobs,
      activeActorJobCount: limits?.current?.activeActorJobCount,
      maxActorMemoryGbytes: limits?.limits?.maxActorMemoryGbytes,
    },
    targetRun: targetRun ? { id: targetRun.id, status: targetRun.status, startedAt: targetRun.startedAt, finishedAt: targetRun.finishedAt, usageTotalUsd: targetRun.usageTotalUsd } : null,
    workerRuns: {
      totalShown: items.length,
      running: items.filter((r: any) => r.status === "RUNNING").length,
      ready: items.filter((r: any) => r.status === "READY").length,
      succeeded: items.filter((r: any) => r.status === "SUCCEEDED").length,
      failed: items.filter((r: any) => ["FAILED", "ABORTED", "TIMED-OUT"].includes(r.status)).length,
      latest: items.slice(0, 40).map((r: any) => ({ id: r.id, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, usageTotalUsd: r.usageTotalUsd })),
    },
    orchestratorRuns: (orchestratorRuns.items ?? []).slice(0, 10).map((r: any) => ({ id: r.id, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, usageTotalUsd: r.usageTotalUsd })),
    runtime: { status, state, budget, lease },
  };
}

async function scheduleAndRun(workerId: string, orchestratorId: string, forceLease: boolean) {
  await Promise.all([
    apify(`/actors/${encodeURIComponent(workerId)}`, { method: "PUT", body: JSON.stringify({ actorPermissionLevel: "FULL_PERMISSIONS" }) }),
    apify(`/actors/${encodeURIComponent(orchestratorId)}`, { method: "PUT", body: JSON.stringify({ actorPermissionLevel: "FULL_PERMISSIONS" }) }),
  ]);
  const [limits, schedules] = await Promise.all([apify("/users/me/limits"), apify("/schedules?limit=1000")]);
  const maxConcurrentJobs = Math.max(2, Number(limits?.limits?.maxConcurrentActorJobs ?? 32));
  const scheduleInput = {
    workerActorId: workerId,
    mode: "auto",
    localConcurrency: 10,
    maxWorkerItems: 1200,
    maxWorkerRunMinutes: 30,
    maxCycleMinutes: 170,
    dailyBudgetUsd: 10,
    projectBudgetUsd: 50,
    maxConcurrentJobs,
    displayBaseUrl: DISPLAY_BASE_URL,
    displayToken: secret("SOURCE_WORKER_TOKEN"),
  };
  const scheduleBody = {
    name: "source-scan-native-autopilot",
    title: "Source Scan Native Autopilot",
    description: "Apify-native control plane. Lovable is one-way display telemetry only.",
    isEnabled: true,
    isExclusive: true,
    cronExpression: "*/15 * * * *",
    timezone: "Asia/Ho_Chi_Minh",
    actions: [{
      type: "RUN_ACTOR",
      actorId: orchestratorId,
      runInput: { body: JSON.stringify(scheduleInput), contentType: "application/json; charset=utf-8" },
      runOptions: { build: "latest", timeoutSecs: 10800, memoryMbytes: 256, maxTotalChargeUsd: 0.5, restartOnError: false },
    }],
  };
  const existing = (schedules.items ?? []).find((s: any) => s.name === scheduleBody.name);
  const schedule = existing
    ? await apify(`/schedules/${encodeURIComponent(existing.id)}`, { method: "PUT", body: JSON.stringify(scheduleBody) })
    : await apify("/schedules", { method: "POST", body: JSON.stringify(scheduleBody) });
  const params = new URLSearchParams({ memory: "256", timeout: "10800", build: "latest", maxTotalChargeUsd: "0.5", forcePermissionLevel: "FULL_PERMISSIONS" });
  const run = await apify(`/acts/${encodeURIComponent(orchestratorId)}/runs?${params.toString()}`, {
    method: "POST",
    body: JSON.stringify({ ...scheduleInput, forceLease }),
  });
  return { limits: { maxConcurrentActorJobs: maxConcurrentJobs, activeActorJobCount: limits?.current?.activeActorJobCount }, schedule, run };
}

export const Route = createFileRoute("/api/bootstrap-native-apify")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          if (request.headers.get("x-bootstrap-token") !== BOOTSTRAP_TOKEN) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
          const body = await request.json().catch(() => ({})) as {
            action?: string;
            runId?: string;
            workerFiles?: unknown;
            orchestratorFiles?: unknown;
          };

          if (body.action === "inspect") return Response.json({ ok: true, ...(await inspect(body.runId)) });

          if (body.action === "diagnoseAbort") {
            const { worker } = await actors();
            const runs = await apify(`/acts/${encodeURIComponent(worker.id)}/runs?desc=1&limit=100`);
            const failed = (runs.items ?? []).find((r: any) => r.status === "FAILED");
            const failedLog = failed ? await apifyText(`/logs/${encodeURIComponent(failed.id)}`).catch((error) => String(error)) : null;
            let aborted: any = null;
            if (body.runId) aborted = await apify(`/actor-runs/${encodeURIComponent(body.runId)}/abort?gracefully=false`, { method: "POST" }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
            return Response.json({
              ok: true,
              failedRun: failed ? { id: failed.id, status: failed.status, startedAt: failed.startedAt, finishedAt: failed.finishedAt } : null,
              failedLogTail: failedLog?.slice(-14000) ?? null,
              aborted: aborted ? { id: aborted.id ?? null, status: aborted.status ?? null, error: aborted.error ?? null } : null,
            });
          }

          if (body.action === "buildRestart") {
            const { worker, orchestrator } = await actors();
            const workerFiles = body.workerFiles ? z.array(fileSchema).min(4).max(20).parse(body.workerFiles) : null;
            const orchestratorFiles = body.orchestratorFiles ? z.array(fileSchema).min(4).max(20).parse(body.orchestratorFiles) : null;
            const builds: Record<string, any> = {};
            if (workerFiles) builds.worker = await buildActor(worker.id, workerFiles, [{ name: "BRAVE_SEARCH_API_KEY", value: secret("BRAVE_SEARCH_API_KEY"), isSecret: true }]);
            if (orchestratorFiles) builds.orchestrator = await buildActor(orchestrator.id, orchestratorFiles);
            if (!workerFiles && !orchestratorFiles) throw new Error("At least one Actor source package is required");
            const started = await scheduleAndRun(worker.id, orchestrator.id, true);
            return Response.json({
              ok: true,
              builds: Object.fromEntries(Object.entries(builds).map(([k, b]: any) => [k, { id: b.id, status: b.status }])),
              limits: started.limits,
              schedule: { id: started.schedule.id, enabled: started.schedule.isEnabled, nextRunAt: started.schedule.nextRunAt },
              run: { id: started.run.id, status: started.run.status },
            });
          }

          return Response.json({ ok: false, error: "Unknown action" }, { status: 400 });
        } catch (error) {
          if (error instanceof z.ZodError) return Response.json({ ok: false, error: "Invalid payload", issues: error.issues }, { status: 400 });
          return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
        }
      },
    },
  },
});
