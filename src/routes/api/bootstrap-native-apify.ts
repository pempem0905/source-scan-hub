import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const BOOTSTRAP_TOKEN = "PyqmUpj7SBNd-EB5yw48dkkRz0WbegxfaInGQIelsyU";
const APIFY_BASE = "https://api.apify.com/v2";
const DISPLAY_BASE_URL = "https://source-scan-hub.lovable.app";

const fileSchema = z.object({ name: z.string().min(1).max(300), format: z.literal("TEXT").default("TEXT"), content: z.string().max(500_000) });
const bodySchema = z.object({ workerFiles: z.array(fileSchema).min(4).max(20), orchestratorFiles: z.array(fileSchema).min(4).max(20) });

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
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  if (!res.ok) throw new Error(`Apify ${path} failed ${res.status}: ${text.slice(0, 800)}`);
  return parsed.data ?? parsed;
}

async function apifyText(path: string) {
  const res = await apifyRaw(path);
  const text = await res.text();
  if (!res.ok) throw new Error(`Apify ${path} failed ${res.status}: ${text.slice(0, 800)}`);
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

async function upsertActor(name: string, title: string, sourceFiles: Array<{ name: string; format: "TEXT"; content: string }>) {
  const acts = await apify("/acts?limit=1000");
  let actor = (acts.items ?? []).find((a: any) => a.name === name);
  if (!actor) {
    actor = await apify("/acts", {
      method: "POST",
      body: JSON.stringify({ name, title, isPublic: false, defaultRunOptions: { build: "latest", memoryMbytes: 256, timeoutSecs: 4200, restartOnError: false } }),
    });
  }
  const version = { versionNumber: "1.0", buildTag: "latest", sourceType: "SOURCE_FILES", sourceFiles };
  try {
    await apify(`/acts/${encodeURIComponent(actor.id)}/versions/1.0`, { method: "PUT", body: JSON.stringify(version) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/404|not found/i.test(message)) throw error;
    await apify(`/acts/${encodeURIComponent(actor.id)}/versions`, { method: "POST", body: JSON.stringify(version) });
  }
  const build = await apify(`/acts/${encodeURIComponent(actor.id)}/builds?version=1.0&tag=latest`, { method: "POST" });
  const finished = await waitBuild(build.id);
  if (finished.status !== "SUCCEEDED") {
    const logText = await apifyText(`/logs/${encodeURIComponent(build.id)}`).catch(() => "");
    const tail = logText.slice(-5000);
    throw new Error(`${name} build ended with ${finished.status}; buildId=${build.id}; logTail=${tail}`);
  }
  return { actor, build: finished };
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
          if (request.headers.get("x-bootstrap-token") !== BOOTSTRAP_TOKEN) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
          const payload = bodySchema.parse(await request.json());

          const worker = await upsertActor("source-scan-native-worker", "Source Scan Native Worker", payload.workerFiles);
          const orchestrator = await upsertActor("source-scan-native-orchestrator", "Source Scan Native Orchestrator", payload.orchestratorFiles);
          const limits = await apify("/users/me/limits");
          const migrated = await migrationRows();

          const scheduleInput = {
            workerActorId: worker.actor.id,
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
            description: "Apify-native source discovery control plane. Lovable is display-only and never consulted for queueing, retries, scaling, or scan decisions.",
            isEnabled: true,
            isExclusive: true,
            cronExpression: "0 */3 * * *",
            timezone: "Asia/Ho_Chi_Minh",
            actions: [{
              type: "RUN_ACTOR",
              actorId: orchestrator.actor.id,
              runInput: { body: JSON.stringify(scheduleInput), contentType: "application/json; charset=utf-8" },
              runOptions: { build: "latest", timeoutSecs: 4200, memoryMbytes: 256, maxTotalChargeUsd: 0.1, restartOnError: false },
            }],
          };

          const schedules = await apify("/schedules?limit=1000");
          for (const old of (schedules.items ?? []).filter((s: any) => s.name === "source-scan-hub-autopilot" && s.isEnabled)) {
            await apify(`/schedules/${encodeURIComponent(old.id)}`, { method: "PUT", body: JSON.stringify({ ...old, isEnabled: false }) });
          }
          const existing = (schedules.items ?? []).find((s: any) => s.name === scheduleBody.name);
          const schedule = existing
            ? await apify(`/schedules/${encodeURIComponent(existing.id)}`, { method: "PUT", body: JSON.stringify(scheduleBody) })
            : await apify("/schedules", { method: "POST", body: JSON.stringify(scheduleBody) });

          const runParams = new URLSearchParams({ memory: "256", timeout: "4200", build: "latest", maxTotalChargeUsd: "0.1" });
          const run = await apify(`/acts/${encodeURIComponent(orchestrator.actor.id)}/runs?${runParams.toString()}`, { method: "POST", body: JSON.stringify(firstRunInput) });

          return Response.json({
            ok: true,
            worker: { id: worker.actor.id, buildId: worker.build.id, buildStatus: worker.build.status },
            orchestrator: { id: orchestrator.actor.id, buildId: orchestrator.build.id, buildStatus: orchestrator.build.status },
            limits: { maxConcurrentActorJobs: limits?.limits?.maxConcurrentActorJobs, activeActorJobCount: limits?.current?.activeActorJobCount, maxActorMemoryGbytes: limits?.limits?.maxActorMemoryGbytes },
            migration: { sources: migrated.sources.length, candidates: migrated.candidates.length },
            schedule: { id: schedule.id, name: schedule.name, enabled: schedule.isEnabled, nextRunAt: schedule.nextRunAt },
            run: { id: run.id, status: run.status },
          });
        } catch (error) {
          if (error instanceof z.ZodError) return Response.json({ ok: false, error: "Invalid payload", issues: error.issues }, { status: 400 });
          return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
        }
      },
    },
  },
});
