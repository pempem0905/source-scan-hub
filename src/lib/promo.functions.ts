import { createServerFn } from "@tanstack/react-start";

async function admin(): Promise<any> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

export const getPromoMaster = createServerFn({ method: "GET" }).handler(async () => {
  const db = await admin();
  const [{ data: state, error: stateErr }, { data: health, error: healthErr }] = await Promise.all([
    db.from("promo_master_state").select("*").maybeSingle(),
    db.from("promo_writer_health").select("*").maybeSingle(),
  ]);
  if (stateErr) throw stateErr;
  if (healthErr) throw healthErr;
  return { state: state ?? null, health: health ?? null, fetchedAt: new Date().toISOString() };
});

export const getPromoQueueStats = createServerFn({ method: "GET" }).handler(async () => {
  const db = await admin();
  const countBy = async (status: string) => {
    const { count, error } = await db
      .from("promo_candidate_queue")
      .select("*", { count: "exact", head: true })
      .eq("status", status);
    if (error) throw error;
    return count ?? 0;
  };
  const [ready, committed, rejected] = await Promise.all([
    countBy("READY"),
    countBy("COMMITTED"),
    countBy("REJECTED"),
  ]);
  const { data: oldest, error } = await db
    .from("promo_candidate_queue")
    .select("created_at")
    .eq("status", "READY")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return {
    ready,
    committed,
    rejected,
    oldestReadyAt: (oldest?.created_at as string | undefined) ?? null,
  };
});

export const getPromoCommits = createServerFn({ method: "GET" }).handler(async () => {
  const db = await admin();
  const { data, error } = await db
    .from("promo_master_commits")
    .select(
      "commit_id,batch_no,previous_batch_no,checkpoint,registered_delta,scanned_delta,offers_delta,codes_delta,queue_ids,created_at",
    )
    .order("batch_no", { ascending: false })
    .limit(12);
  if (error) throw error;
  return (data ?? []).map((r: any) => ({
    commit_id: r.commit_id,
    batch_no: r.batch_no,
    previous_batch_no: r.previous_batch_no,
    checkpoint: r.checkpoint,
    registered_delta: r.registered_delta,
    scanned_delta: r.scanned_delta,
    offers_delta: r.offers_delta,
    codes_delta: r.codes_delta,
    rows: Array.isArray(r.queue_ids) ? r.queue_ids.length : 0,
    created_at: r.created_at,
  }));
});

export const getPromoWorkers = createServerFn({ method: "GET" }).handler(async () => {
  const db = await admin();
  const { data, error } = await db
    .from("worker_stats")
    .select(
      "id,worker_id,lane,status,last_heartbeat,requests_total,qualified_sources_total,errors_total,rate_403,rate_429",
    )
    .order("last_heartbeat", { ascending: false })
    .limit(60);
  if (error) throw error;
  return data ?? [];
});
