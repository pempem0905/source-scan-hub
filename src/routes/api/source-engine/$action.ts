import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { applyOriginResolution, heartbeatWorker, ingestCandidate, recordApiUsage } from "@/source-engine/store.server";
import { claimNextTarget, completeTarget, failTarget, retryTarget } from "@/source-engine/queue.server";
import { SOURCE_TYPES, WORKER_LANES } from "@/source-engine/types";
import { assertWorkerRequest, workerErrorResponse } from "@/source-engine/worker-auth.server";

const sourceTypeSchema = z.enum(SOURCE_TYPES);
const workerLaneSchema = z.enum(WORKER_LANES);

const candidateSchema = z.object({
  url: z.string().url(),
  domain: z.string().nullable().optional(),
  sourceType: sourceTypeSchema.nullable().optional(),
  discoveredVia: z.string().nullable().optional(),
  discoverySourceId: z.string().uuid().nullable().optional(),
  merchantId: z.string().uuid().nullable().optional(),
  market: z.string().default("VN"),
  notes: z.string().nullable().optional(),
});

const heartbeatSchema = z.object({
  workerId: z.string().min(1).max(200),
  lane: workerLaneSchema,
  status: z.enum(["idle", "running", "paused", "error"]),
  requestsTotal: z.number().int().nonnegative().optional(),
  qualifiedSourcesTotal: z.number().int().nonnegative().optional(),
  errorsTotal: z.number().int().nonnegative().optional(),
  rate403: z.number().nonnegative().optional(),
  rate429: z.number().nonnegative().optional(),
  currentJobId: z.string().uuid().nullable().optional(),
});

const resolutionSchema = z.object({
  candidateId: z.string().uuid(),
  resolution: z.object({
    discoveredUrl: z.string().url(),
    finalUrl: z.string().url(),
    canonicalUrl: z.string().url(),
    canonicalDomain: z.string().min(1),
    redirectChain: z.array(z.string().url()).max(20),
    httpStatus: z.number().int().nullable(),
    resolutionStatus: z.enum(["pending", "resolved", "unresolved", "blocked", "failed"]),
    confidence: z.number().min(0).max(1),
    error: z.string().optional(),
  }),
});

async function bodyJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const error = new Error("Content-Type must be application/json");
    (error as Error & { status?: number }).status = 415;
    throw error;
  }
  return request.json();
}

export const Route = createFileRoute("/api/source-engine/$action")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          assertWorkerRequest(request);
          const action = params.action;
          const body = await bodyJson(request);

          if (action === "candidates") {
            const payload = z.object({ candidates: z.array(candidateSchema).min(1).max(500) }).parse(body);
            const rows = [];
            for (const candidate of payload.candidates) rows.push(await ingestCandidate(candidate));
            return Response.json({ ok: true, count: rows.length, rows });
          }

          if (action === "heartbeat") {
            const payload = heartbeatSchema.parse(body);
            return Response.json({ ok: true, worker: await heartbeatWorker(payload) });
          }

          if (action === "claim") {
            const payload = z
              .object({ workerId: z.string().min(1).max(200), lane: workerLaneSchema.optional() })
              .parse(body);
            return Response.json({ ok: true, item: await claimNextTarget(payload.workerId, payload.lane) });
          }

          if (action === "resolution") {
            const payload = resolutionSchema.parse(body);
            return Response.json({
              ok: true,
              candidate: await applyOriginResolution(payload.candidateId, payload.resolution),
            });
          }

          if (action === "complete") {
            const payload = z.object({ queueId: z.string().uuid() }).parse(body);
            return Response.json({ ok: true, item: await completeTarget(payload.queueId) });
          }

          if (action === "retry") {
            const payload = z
              .object({ queueId: z.string().uuid(), delayMs: z.number().int().min(0).max(86_400_000) })
              .parse(body);
            return Response.json({ ok: true, item: await retryTarget(payload.queueId, payload.delayMs) });
          }

          if (action === "fail") {
            const payload = z.object({ queueId: z.string().uuid() }).parse(body);
            return Response.json({ ok: true, item: await failTarget(payload.queueId) });
          }

          if (action === "usage") {
            const payload = z
              .object({
                provider: z.string().min(1).max(100),
                requests: z.number().int().nonnegative().optional(),
                credits: z.number().nonnegative().optional(),
                costUsd: z.number().nonnegative().optional(),
              })
              .parse(body);
            return Response.json({ ok: true, usage: await recordApiUsage(payload) });
          }

          return Response.json({ ok: false, error: "Unknown source-engine action" }, { status: 404 });
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
