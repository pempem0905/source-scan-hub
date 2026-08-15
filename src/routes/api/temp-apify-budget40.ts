import { createFileRoute } from "@tanstack/react-router";

const APIFY_BASE = "https://api.apify.com/v2";
const ONE_SHOT = "budget40-20260815-2249";

function secret(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} missing`);
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
  if (!res.ok) throw new Error(`Apify ${path} ${res.status}: ${text.slice(0,1200)}`);
  return payload.data ?? payload;
}

export const Route = createFileRoute("/api/temp-apify-budget40")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          if (request.headers.get("x-one-shot") !== ONE_SHOT) return Response.json({ ok:false }, { status:401 });
          const [schedules, actors, limits] = await Promise.all([
            apify("/schedules?limit=1000"),
            apify("/acts?limit=1000"),
            apify("/users/me/limits"),
          ]);
          const schedule = (schedules.items ?? []).find((s:any) => s.name === "source-scan-native-autopilot");
          const orchestrator = (actors.items ?? []).find((a:any) => a.name === "source-scan-native-orchestrator");
          const worker = (actors.items ?? []).find((a:any) => a.name === "source-scan-native-worker");
          if (!schedule || !orchestrator || !worker) throw new Error("schedule/orchestrator/worker not found");
          const action = schedule.actions?.[0];
          const oldInput = action?.runInput?.body ? JSON.parse(action.runInput.body) : {};
          const runInput = {
            ...oldInput,
            workerActorId: worker.id,
            dailyBudgetUsd: 40,
            projectBudgetUsd: 50,
            maxConcurrentJobs: Math.max(2, Number(limits?.limits?.maxConcurrentActorJobs ?? 32)),
          };
          const scheduleBody = {
            name: schedule.name,
            title: schedule.title,
            description: schedule.description,
            isEnabled: true,
            isExclusive: true,
            cronExpression: schedule.cronExpression || "*/15 * * * *",
            timezone: schedule.timezone || "Asia/Ho_Chi_Minh",
            actions: [{
              ...action,
              runInput: { body: JSON.stringify(runInput), contentType: "application/json; charset=utf-8" },
            }],
          };
          const updated = await apify(`/schedules/${encodeURIComponent(schedule.id)}`, { method:"PUT", body:JSON.stringify(scheduleBody) });
          const params = new URLSearchParams({ memory:"256", timeout:"10800", build:"latest", maxTotalChargeUsd:"0.5", forcePermissionLevel:"FULL_PERMISSIONS" });
          const run = await apify(`/acts/${encodeURIComponent(orchestrator.id)}/runs?${params.toString()}`, {
            method:"POST",
            body:JSON.stringify({ ...runInput, forceLease:true }),
          });
          return Response.json({
            ok:true,
            dailyBudgetUsd:40,
            projectBudgetUsd:50,
            workerActorId:worker.id,
            maxConcurrentJobs:runInput.maxConcurrentJobs,
            schedule:{ id:updated.id, nextRunAt:updated.nextRunAt, enabled:updated.isEnabled },
            run:{ id:run.id, status:run.status },
          });
        } catch (error) {
          return Response.json({ ok:false, error:error instanceof Error ? error.message : String(error) }, { status:500 });
        }
      },
    },
  },
});
