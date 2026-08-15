import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const BOOTSTRAP_TOKEN = "A-bJiCblqjurbY-6glgsQRV6FZq0a7BhDvRr52W04pM";
const APIFY_BASE = "https://api.apify.com/v2";
const WORKER_ACTOR_ID = "Qg9euRGDO7q5wbit4";

const fileSchema = z.object({
  name: z.string().min(1).max(300),
  format: z.literal("TEXT").default("TEXT"),
  content: z.string().max(300_000),
});

const bodySchema = z.object({
  actorName: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
  sourceFiles: z.array(fileSchema).min(3).max(20),
});

function apifyToken() {
  const value = process.env["APIFY_TOKEN"];
  if (!value) throw new Error("APIFY_TOKEN is missing from server secrets");
  return value;
}

function workerToken() {
  const value = process.env["SOURCE_WORKER_TOKEN"];
  if (!value) throw new Error("SOURCE_WORKER_TOKEN is missing from server secrets");
  return value;
}

async function apify(path: string, init: RequestInit = {}) {
  const res = await fetch(`${APIFY_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apifyToken()}`,
      accept: "application/json",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) throw new Error(`Apify ${path} failed ${res.status}: ${text.slice(0, 700)}`);
  return parsed.data ?? parsed;
}

async function waitBuild(buildId: string) {
  const deadline = Date.now() + 4 * 60 * 1000;
  while (Date.now() < deadline) {
    const build = await apify(`/actor-builds/${encodeURIComponent(buildId)}`);
    if (["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(build.status)) return build;
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  throw new Error("Timed out waiting for orchestrator build");
}

export const Route = createFileRoute("/api/bootstrap-apify")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          if (request.headers.get("x-bootstrap-token") !== BOOTSTRAP_TOKEN) {
            return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
          }
          const payload = bodySchema.parse(await request.json());

          const acts = await apify("/acts?limit=1000");
          let actor = (acts.items ?? []).find((a: any) => a.name === payload.actorName);
          if (!actor) {
            actor = await apify("/acts", {
              method: "POST",
              body: JSON.stringify({
                name: payload.actorName,
                title: "Source Scan Hub Autopilot",
                isPublic: false,
                defaultRunOptions: {
                  build: "latest",
                  memoryMbytes: 256,
                  timeoutSecs: 3600,
                  restartOnError: false,
                },
              }),
            });
          }

          const version = {
            versionNumber: "0.1",
            buildTag: "latest",
            sourceType: "SOURCE_FILES",
            sourceFiles: payload.sourceFiles,
          };
          try {
            await apify(`/acts/${encodeURIComponent(actor.id)}/versions/0.1`, {
              method: "PUT",
              body: JSON.stringify(version),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/404|not found/i.test(message)) throw error;
            await apify(`/acts/${encodeURIComponent(actor.id)}/versions`, {
              method: "POST",
              body: JSON.stringify(version),
            });
          }

          const build = await apify(`/acts/${encodeURIComponent(actor.id)}/builds?version=0.1&tag=latest`, {
            method: "POST",
          });
          const finishedBuild = await waitBuild(build.id);
          if (finishedBuild.status !== "SUCCEEDED") {
            throw new Error(`Orchestrator build ended with ${finishedBuild.status}`);
          }

          const actorInput = {
            hubBaseUrl: "https://source-scan-hub.lovable.app",
            workerToken: workerToken(),
            workerActorId: WORKER_ACTOR_ID,
            mode: "auto",
            maxResolverWorkers: 16,
            maxCycleSpendUsd: 0.2,
            maxCycleMinutes: 45,
          };

          const scheduleBody = {
            name: "source-scan-hub-autopilot",
            title: "Source Scan Hub Autopilot",
            description: "Phase 1 source discovery. Master cycles every 3 hours until convergence; auto switches to daily behavior after baseline is mature.",
            isEnabled: true,
            isExclusive: true,
            cronExpression: "0 */3 * * *",
            timezone: "Asia/Ho_Chi_Minh",
            actions: [
              {
                type: "RUN_ACTOR",
                actorId: actor.id,
                runInput: {
                  body: JSON.stringify(actorInput),
                  contentType: "application/json; charset=utf-8",
                },
                runOptions: {
                  build: "latest",
                  timeoutSecs: 3600,
                  memoryMbytes: 256,
                  maxTotalChargeUsd: 0.25,
                  restartOnError: false,
                },
              },
            ],
          };

          const schedules = await apify("/schedules?limit=1000");
          const existingSchedule = (schedules.items ?? []).find((s: any) => s.name === scheduleBody.name);
          const schedule = existingSchedule
            ? await apify(`/schedules/${encodeURIComponent(existingSchedule.id)}`, {
                method: "PUT",
                body: JSON.stringify(scheduleBody),
              })
            : await apify("/schedules", {
                method: "POST",
                body: JSON.stringify(scheduleBody),
              });

          const params = new URLSearchParams({
            memory: "256",
            timeout: "3600",
            build: "latest",
            maxTotalChargeUsd: "0.25",
          });
          const run = await apify(`/acts/${encodeURIComponent(actor.id)}/runs?${params.toString()}`, {
            method: "POST",
            body: JSON.stringify(actorInput),
          });

          return Response.json({
            ok: true,
            actor: { id: actor.id, name: actor.name },
            build: { id: finishedBuild.id, status: finishedBuild.status },
            schedule: {
              id: schedule.id,
              name: schedule.name,
              enabled: schedule.isEnabled,
              nextRunAt: schedule.nextRunAt,
            },
            run: { id: run.id, status: run.status },
          });
        } catch (error) {
          if (error instanceof z.ZodError) {
            return Response.json({ ok: false, error: "Invalid bootstrap payload", issues: error.issues }, { status: 400 });
          }
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
