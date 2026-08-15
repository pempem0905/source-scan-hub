import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type PromoCandidate = {
  idempotencyKey: string;
  sourceWorker: string;
  sourceUrl?: string | null;
  candidate: Record<string, unknown>;
};

export async function enqueuePromoCandidates(items: PromoCandidate[]) {
  if (!items.length) return [];
  const rows = items.map((item) => ({
    idempotency_key: item.idempotencyKey,
    source_worker: item.sourceWorker,
    source_url: item.sourceUrl ?? null,
    candidate: item.candidate,
    status: "READY",
  }));

  const { data, error } = await (supabaseAdmin as any)
    .from("promo_candidate_queue")
    .upsert(rows, { onConflict: "idempotency_key", ignoreDuplicates: true })
    .select("id,idempotency_key,status");
  if (error) throw error;
  return data ?? [];
}

export async function getPromoWriterHealth() {
  const { data, error } = await (supabaseAdmin as any)
    .from("promo_writer_health")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function listReadyPromoCandidates(limit = 12) {
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const { data, error } = await (supabaseAdmin as any)
    .from("promo_candidate_queue")
    .select("id,idempotency_key,source_worker,source_url,candidate,created_at")
    .eq("status", "READY")
    .order("created_at", { ascending: true })
    .limit(safeLimit);
  if (error) throw error;
  return data ?? [];
}

export async function commitPromoCandidates(input: {
  expectedBatch: number;
  nextBatch: number;
  checkpoint: string;
  queueIds: string[];
  registeredDelta: number;
  scannedDelta: number;
  offersDelta: number;
  codesDelta: number;
}) {
  const { data, error } = await (supabaseAdmin as any).rpc("commit_promo_queue", {
    p_expected_batch: input.expectedBatch,
    p_next_batch: input.nextBatch,
    p_checkpoint: input.checkpoint,
    p_queue_ids: input.queueIds,
    p_registered_delta: input.registeredDelta,
    p_scanned_delta: input.scannedDelta,
    p_offers_delta: input.offersDelta,
    p_codes_delta: input.codesDelta,
  });
  if (error) throw error;
  return data as string;
}
