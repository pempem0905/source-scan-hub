import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { enqueuePromoCandidates } from "@/source-engine/promo-writer.server";
import { assertWorkerRequest, workerErrorResponse } from "@/source-engine/worker-auth.server";

const candidateSchema = z.object({
  idempotencyKey: z.string().min(8).max(300),
  sourceWorker: z.string().min(1).max(120),
  sourceUrl: z.string().url().nullable().optional(),
  candidate: z.record(z.string(), z.unknown()),
});

const bodySchema = z.object({
  items: z.array(candidateSchema).min(1).max(50),
});

export const Route = createFileRoute("/api/promo-queue")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          assertWorkerRequest(request);
          const payload = bodySchema.parse(await request.json());
          const rows = await enqueuePromoCandidates(payload.items);
          return Response.json({ ok: true, accepted: rows.length, rows });
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
