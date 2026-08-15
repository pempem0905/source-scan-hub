import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  finishAutopilotCycle,
  getAutopilotStats,
  prepareAutopilotCycle,
} from "@/source-engine/autopilot.server";
import { assertWorkerRequest, workerErrorResponse } from "@/source-engine/worker-auth.server";

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("prepare"),
    mode: z.enum(["auto", "master", "daily"]).default("auto"),
  }),
  z.object({
    action: z.literal("stats"),
    workerPrefix: z.string().max(200).nullable().optional(),
  }),
  z.object({
    action: z.literal("finish"),
    mode: z.enum(["master", "daily"]),
    sourceCountBefore: z.number().int().nonnegative(),
    workerPrefix: z.string().max(200).nullable().optional(),
    apifyCostUsd: z.number().nonnegative().optional(),
  }),
]);

export const Route = createFileRoute("/api/autopilot")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          assertWorkerRequest(request);
          const contentType = request.headers.get("content-type") ?? "";
          if (!contentType.includes("application/json")) {
            return Response.json({ ok: false, error: "Content-Type must be application/json" }, { status: 415 });
          }
          const payload = bodySchema.parse(await request.json());
          if (payload.action === "prepare") {
            return Response.json({ ok: true, result: await prepareAutopilotCycle(payload.mode) });
          }
          if (payload.action === "stats") {
            return Response.json({ ok: true, result: await getAutopilotStats(payload.workerPrefix) });
          }
          return Response.json({ ok: true, result: await finishAutopilotCycle(payload) });
        } catch (error) {
          if (error instanceof z.ZodError) {
            return Response.json({ ok: false, error: "Invalid payload", issues: error.issues }, { status: 400 });
          }
          return workerErrorResponse(error);
        }
      },
    },
  },
});
