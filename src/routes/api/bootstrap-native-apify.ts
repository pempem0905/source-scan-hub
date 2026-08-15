import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const BOOTSTRAP_TOKEN = "vKd5jIOoKvbcGSy7zWi0-LOVDXVNVjtU6RoHOq2z9oM";
const APIFY_BASE = "https://api.apify.com/v2";
const DISPLAY_BASE_URL = "https://source-scan-hub.lovable.app";

const fileSchema = z.object({
  name: z.string().min(1).max(300),
  format: z.literal("TEXT").default("TEXT"),
  content: z.string().max(600_000),
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
  if (!res.ok) throw new Error(`Apify ${path} failed ${res.status}: ${text.slice(0, 1600)}`);
  return payload.data ?? payload;
}

async function apifyText(path: string) {
  const res = await apifyRaw(path);
  const text = await res.text();
  if (!res.ok) throw new Error(`Apify ${path} failed ${res.status}: ${text.slice(0, 1000)}`);
  return text;
}

async function waitBuild(buildId: string) {
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    const build = await apify(`/actor-builds/${encodeURIComponent(buildId)}`);
    if (["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(build.status)) return build;
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  throw new Error(`Timed out waiting for build ${buildId}`);
}

async function nativeActors() {
  const acts = await apify("/acts?limit=1000");
  const worker = (acts.items ?? []).find((a: any) => a.name === "source-scan-native-worker");
  const orchestrator = (acts.items ?? []).find((a: any) => a.name === "source-scan-native-orchestrator");
  if (!worker || !orchestrator) throw new Error("Native Actors are not present");
  return { worker, orchestrator };
}

async function inspectNative(runId?: string) {
  const { worker, orchestrator } = await nativeActors();
  const [limits, workerRuns, orchestratorRuns, stores] = await Promise.all([
    apify("/users/me/limits"),
    apify(`/acts/${encodeURIComponent(worker.id)}/runs?desc=1&limit=100`),
    apify(`/acts/${encodeURIComponent(orchestrator.id)}/runs?desc=1&limit=20`),
    apify("/key-value-stores?limit=1000"),
  ]);
  const runtimeStore = (stores.items ?? []).find((s: any) => s.name === "source-scan-native-runtime-v1");
  const [status, state, budget, lease] = runtimeStore ? await Promise.all([
    apify(`/key-value-stores/${runtimeStore.id}/records/STATUS`).catch(() => null),
    apify(`/key-value-stores/${runtimeStore.id}/records/STATE`).catch(() => null),
    apify(`/key-value-stores/${runtimeStore.id}/records/BUDGET`).catch(() => null),
    apify(`/key-value-stores/${runtimeStore.id}/records/LEASE`).catch(() => null),
  ]) : [null, null, null, null];
  const targetRun = runId ? await apify(`/actor-runs/${encodeURIComponent(runId)}`).catch(() => null) : null;
  const workerItems = workerRuns.items ?? [];
  return {
    limits: {
      maxConcurrentActorJobs: limits?.limits?.maxConcurrentActorJobs,
      activeActorJobCount: limits?.current?.activeActorJobCount,
      maxActorMemoryGbytes: limits?.limits?.maxActorMemoryGbytes,
    },
    targetRun: targetRun ? { id: targetRun.id, status: targetRun.status, startedAt: targetRun.startedAt, finishedAt: targetRun.finishedAt, usageTotalUsd: targetRun.usageTotalUsd } : null,
    workerRuns: {
      totalShown: workerItems.length,
      running: workerItems.filter((r: any) => r.status === "RUNNING").length,
      ready: workerItems.filter((r: any) => r.status === "READY").length,
      succeeded: workerItems.filter((r: any) => r.status === "SUCCEEDED").length,
      failed: workerItems.filter((r: any) => ["FAILED", "ABORTED", "TIMED-OUT"].includes(r.status)).length,
      latest: workerItems.slice(0, 40).map((r: any) => ({ id: r.id, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, usageTotalUsd: r.usageTotalUsd })),
    },
    orchestratorRuns: (orchestratorRuns.items ?? []).slice(0, 10).map((r: any) => ({ id: r.id, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, usageTotalUsd: r.usageTotalUsd })),
    runtime: { status, state, budget, lease },
  };
}

export const Route = createFileRoute("/api/bootstrap-native-apify")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          if (request.headers.get("x-bootstrap-token") !== BOOTSTRAP_TOKEN) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
          const body = await request.json().catch(() => ({})) as { action?: string; runId?: string; orchestratorFiles?: unknown };

          if (body.action === "inspect") {
            return Response.json({ ok: true, ...(await inspectNative(body.runId)) });
          }

          if (body.action === "buildRestart") {
            const files = z.array(fileSchema).min(4).max(20).parse(body.orchestratorFiles);
            const { worker, orchestrator } = await nativeActors();
            const version = { versionNumber: "1.0", buildTag: "latest", sourceType: "SOURCE_FILES", sourceFiles: files };
            await apify(`/acts/${encodeURIComponent(orchestrator.id)}/versions/1.0`, { method: "PUT", body: JSON.stringify(version) });
            const build = await apify(`/acts/${encodeURIComponent(orchestrator.id)}/builds?version=1.0&tag=latest`, { method: "POST" });
            const finished = await waitBuild(build.id);
            if (finished.status !== "SUCCEEDED") {
              const logTail = (await apifyText(`/logs/${encodeURIComponent(build.id)}`).catch(() => "")).slice(-6000);
              throw new Error(`Native orchestrator build ${finished.status}; ${logTail}`);
            }

            const [limits, schedules] = await Promise.all([apify("/users/me/limits"), apify("/schedules?limit=1000")]);
            const maxConcurrentJobs = Math.max(2, Number(limits?.limits?.maxConcurrentActorJobs ?? 32));
            const scheduleInput = {
              workerActorId: worker.id,
              mode: "auto",
              localConcurrency: 10,
              maxWorkerItems: 600,
              maxWorkerRunMinutes: 20,
              maxCycleMinutes: 50,
              dailyBudgetUsd: 1,
              projectBudgetUsd: 50,
              maxConcurrentJobs,
              displayBaseUrl: DISPLAY_BASE_URL,
              displayToken: secret("SOURCE_WORKER_TOKEN"),
            };
            const scheduleBody = {
              name: "source-scan-native-autopilot",
              title: "Source Scan Native Autopilot",
              description: "Apify-native source discovery control plane. Lovable receives one-way display telemetry only.",
              isEnabled: true,
              isExclusive: true,
              cronExpression: "0 */3 * * *",
              timezone: "Asia/Ho_Chi_Minh",
              actions: [{
                type: "RUN_ACTOR",
                actorId: orchestrator.id,
                runInput: { body: JSON.stringify(scheduleInput), contentType: "application/json; charset=utf-8" },
                runOptions: { build: "latest", timeoutSecs: 4200, memoryMbytes: 256, maxTotalChargeUsd: 0.1, restartOnError: false },
              }],
            };
            const existing = (schedules.items ?? []).find((s: any) => s.name === scheduleBody.name);
            const schedule = existing
              ? await apify(`/schedules/${encodeURIComponent(existing.id)}`, { method: "PUT", body: JSON.stringify(scheduleBody) })
              : await apify("/schedules", { method: "POST", body: JSON.stringify(scheduleBody) });

            const params = new URLSearchParams({ memory: "256", timeout: "4200", build: "latest", maxTotalChargeUsd: "0.1" });
            const run = await apify(`/acts/${encodeURIComponent(orchestrator.id)}/runs?${params.toString()}`, {
              method: "POST",
              body: JSON.stringify({ ...scheduleInput, forceLease: true }),
            });
            return Response.json({
              ok: true,
              build: { id: finished.id, status: finished.status },
              limits: { maxConcurrentActorJobs: maxConcurrentJobs, activeActorJobCount: limits?.current?.activeActorJobCount },
              schedule: { id: schedule.id, enabled: schedule.isEnabled, nextRunAt: schedule.nextRunAt },
              run: { id: run.id, status: run.status },
            });
          }

          return Response.json({ ok: false, error: "Unknown one-time native action" }, { status: 400 });
        } catch (error) {
          if (error instanceof z.ZodError) return Response.json({ ok: false, error: "Invalid payload", issues: error.issues }, { status: 400 });
          return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
        }
      },
    },
  },
});
