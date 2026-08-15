import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const BOOTSTRAP_TOKEN = "vKd5jIOoKvbcGSy7zWi0-LOVDXVNVjtU6RoHOq2z9oM";
const APIFY_BASE = "https://api.apify.com/v2";
const DISPLAY_BASE_URL = "https://source-scan-hub.lovable.app";

function secret(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing from server secrets`);
  return value;
}

async function apify(path: string, init: RequestInit = {}) {
  const res = await fetch(`${APIFY_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${secret("APIFY_TOKEN")}`,
      accept: "application/json",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let payload: any;
  try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
  if (!res.ok) throw new Error(`Apify ${path} failed ${res.status}: ${text.slice(0, 1200)}`);
  return payload.data ?? payload;
}

async function migrationRows() {
  const [sourcesRes, candidatesRes] = await Promise.all([
    supabaseAdmin.from("sources").select("url,canonical_url,domain,canonical_domain,source_type,market,authority_score,discovered_via,is_radar,is_official").limit(5000),
    supabaseAdmin.from("source_candidates").select("url,canonical_url,domain,canonical_domain,source_type,market,authority_score,discovered_via,is_radar,is_official,resolution_status").limit(10000),
  ]);
  if (sourcesRes.error) throw sourcesRes.error;
  if (candidatesRes.error) throw candidatesRes.error;
  return { sources: sourcesRes.data ?? [], candidates: candidatesRes.data ?? [] };
}

export const Route = createFileRoute("/api/bootstrap-native-apify")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          if (request.headers.get("x-bootstrap-token") !== BOOTSTRAP_TOKEN) {
            return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
          }
          const body = await request.json().catch(() => ({})) as { action?: string; runId?: string };
          const acts = await apify("/acts?limit=1000");
          const worker = (acts.items ?? []).find((a: any) => a.name === "source-scan-native-worker");
          const orchestrator = (acts.items ?? []).find((a: any) => a.name === "source-scan-native-orchestrator");
          if (!worker || !orchestrator) throw new Error("Native Actors are not present");

          if (body.action === "inspect") {
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
            const targetRun = body.runId ? await apify(`/actor-runs/${encodeURIComponent(body.runId)}`).catch(() => null) : null;
            const workerItems = workerRuns.items ?? [];
            return Response.json({
              ok: true,
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
            });
          }

          const [limits, migrated, schedules] = await Promise.all([
            apify("/users/me/limits"),
            migrationRows(),
            apify("/schedules?limit=1000"),
          ]);
          for (const old of (schedules.items ?? []).filter((s: any) => s.name === "source-scan-hub-autopilot" && s.isEnabled)) {
            await apify(`/schedules/${encodeURIComponent(old.id)}`, { method: "PUT", body: JSON.stringify({ isEnabled: false }) });
          }
          const scheduleInput = {
            workerActorId: worker.id,
            mode: "auto",
            localConcurrency: 10,
            maxWorkerItems: 600,
            maxWorkerRunMinutes: 20,
            maxCycleMinutes: 50,
            dailyBudgetUsd: 1,
            projectBudgetUsd: 50,
            displayBaseUrl: DISPLAY_BASE_URL,
            displayToken: secret("SOURCE_WORKER_TOKEN"),
          };
          const firstRunInput = { ...scheduleInput, bootstrapSources: migrated.sources, bootstrapCandidates: migrated.candidates };
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
          const run = await apify(`/acts/${encodeURIComponent(orchestrator.id)}/runs?${params.toString()}`, { method: "POST", body: JSON.stringify(firstRunInput) });
          return Response.json({
            ok: true,
            workerActorId: worker.id,
            orchestratorActorId: orchestrator.id,
            limits: { maxConcurrentActorJobs: limits?.limits?.maxConcurrentActorJobs, activeActorJobCount: limits?.current?.activeActorJobCount, maxActorMemoryGbytes: limits?.limits?.maxActorMemoryGbytes },
            migration: { sources: migrated.sources.length, candidates: migrated.candidates.length },
            schedule: { id: schedule.id, enabled: schedule.isEnabled, nextRunAt: schedule.nextRunAt },
            run: { id: run.id, status: run.status },
          });
        } catch (error) {
          return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
        }
      },
    },
  },
});
