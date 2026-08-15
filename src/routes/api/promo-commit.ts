import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { commitPromoCandidates } from "@/source-engine/promo-writer.server";
import { assertWorkerRequest, workerErrorResponse } from "@/source-engine/worker-auth.server";

const bodySchema = z.object({
  expectedBatch: z.number().int().nonnegative(),
  nextBatch: z.number().int().positive(),
  checkpoint: z.string().min(3).max(200),
  queueIds: z.array(z.string().uuid()).min(1).max(50),
  registeredDelta: z.number().int().nonnegative(),
  scannedDelta: z.number().int().nonnegative(),
  offersDelta: z.number().int().nonnegative(),
  codesDelta: z.number().int().nonnegative(),
});

export const Route = createFileRoute("/api/promo-commit")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          assertWorkerRequest(request);
          const payload = bodySchema.parse(await request.json());
          const commitId = await commitPromoCandidates(payload);
          return Response.json({ ok: true, commitId });
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
