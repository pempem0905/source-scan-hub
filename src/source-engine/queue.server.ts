import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { WorkerLane } from "./types";
import { normalizedDomain } from "./url-normalize";

export async function enqueueTarget(input: {
  targetUrl: string;
  lane: WorkerLane;
  priority?: number;
  jobId?: string | null;
}) {
  const targetDomain = normalizedDomain(input.targetUrl);

  const { data: existing } = await supabaseAdmin
    .from("scan_queue")
    .select("*")
    .eq("target_url", input.targetUrl)
    .eq("lane", input.lane)
    .in("status", ["pending", "retry", "running"])
    .maybeSingle();
  if (existing) return existing;

  const { data, error } = await supabaseAdmin
    .from("scan_queue")
    .insert({
      job_id: input.jobId ?? null,
      target_url: input.targetUrl,
      target_domain: targetDomain,
      lane: input.lane,
      status: "pending",
      priority: input.priority ?? 100,
      available_at: new Date().toISOString(),
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function enqueueSearchQuery(input: {
  query: string;
  priority?: number;
  provider?: "brave";
}) {
  const now = new Date().toISOString();
  const { data: job, error: jobError } = await supabaseAdmin
    .from("scan_jobs")
    .insert({
      job_type: "search_query",
      lane: "SEARCH_DISCOVERY",
      status: "pending",
      priority: input.priority ?? 100,
      payload: {
        query: input.query,
        provider: input.provider ?? "brave",
        market: "VN",
      },
      max_attempts: 3,
      scheduled_at: now,
    })
    .select("*")
    .single();
  if (jobError) throw jobError;

  const { data: item, error: queueError } = await supabaseAdmin
    .from("scan_queue")
    .insert({
      job_id: job.id,
      target_url: null,
      target_domain: null,
      lane: "SEARCH_DISCOVERY",
      status: "pending",
      priority: input.priority ?? 100,
      available_at: now,
    })
    .select("*")
    .single();
  if (queueError) throw queueError;
  return { job, item };
}

export async function claimNextTarget(workerId: string, lane?: WorkerLane) {
  // RPC is installed directly in the project DB. Cast keeps this module usable
  // before generated Supabase types are refreshed by Lovable.
  const { data, error } = await (supabaseAdmin as any).rpc("claim_scan_queue_item", {
    p_worker_id: workerId,
    p_lane: lane ?? null,
  });
  if (error) throw error;

  const item = Array.isArray(data) ? (data[0] ?? null) : data;
  if (!item?.job_id) return { item, job: null };

  const { data: job, error: jobError } = await supabaseAdmin
    .from("scan_jobs")
    .select("*")
    .eq("id", item.job_id)
    .maybeSingle();
  if (jobError) throw jobError;

  return { item, job };
}

export async function completeTarget(queueId: string) {
  const { data: item, error: readError } = await supabaseAdmin
    .from("scan_queue")
    .select("*")
    .eq("id", queueId)
    .single();
  if (readError) throw readError;

  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("scan_queue")
    .update({
      status: "completed",
      locked_by: null,
      locked_at: null,
      updated_at: now,
    })
    .eq("id", queueId)
    .select("*")
    .single();
  if (error) throw error;

  if (item.job_id) {
    await supabaseAdmin
      .from("scan_jobs")
      .update({ status: "completed", finished_at: now, updated_at: now })
      .eq("id", item.job_id);
  }

  return data;
}

export async function retryTarget(queueId: string, delayMs: number) {
  const { data: item, error: readError } = await supabaseAdmin
    .from("scan_queue")
    .select("*")
    .eq("id", queueId)
    .single();
  if (readError) throw readError;

  const now = new Date().toISOString();
  const availableAt = new Date(Date.now() + Math.max(0, delayMs)).toISOString();
  const { data, error } = await supabaseAdmin
    .from("scan_queue")
    .update({
      status: "retry",
      locked_by: null,
      locked_at: null,
      available_at: availableAt,
      updated_at: now,
    })
    .eq("id", queueId)
    .select("*")
    .single();
  if (error) throw error;

  if (item.job_id) {
    const { data: job } = await supabaseAdmin
      .from("scan_jobs")
      .select("attempts")
      .eq("id", item.job_id)
      .maybeSingle();
    await supabaseAdmin
      .from("scan_jobs")
      .update({ status: "retry", attempts: Number(job?.attempts ?? 0) + 1, updated_at: now })
      .eq("id", item.job_id);
  }

  return data;
}

export async function failTarget(queueId: string, errorMessage?: string) {
  const { data: item, error: readError } = await supabaseAdmin
    .from("scan_queue")
    .select("*")
    .eq("id", queueId)
    .single();
  if (readError) throw readError;

  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("scan_queue")
    .update({
      status: "failed",
      locked_by: null,
      locked_at: null,
      updated_at: now,
    })
    .eq("id", queueId)
    .select("*")
    .single();
  if (error) throw error;

  if (item.job_id) {
    await supabaseAdmin
      .from("scan_jobs")
      .update({ status: "failed", error: errorMessage ?? null, finished_at: now, updated_at: now })
      .eq("id", item.job_id);
  }

  return data;
}
