import { createFileRoute } from "@tanstack/react-router";
import { getPromoWriterHealth } from "@/source-engine/promo-writer.server";

export const Route = createFileRoute("/api/promo-status")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const health = await getPromoWriterHealth();
          return Response.json(
            { ok: true, mode: "LIVE", master: health },
            { headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } },
          );
        } catch (error) {
          return Response.json(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            { status: 503, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } },
          );
        }
      },
    },
  },
});
