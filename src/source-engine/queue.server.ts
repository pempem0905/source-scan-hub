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

export async function claimNextTarget(workerId: string, lane?: WorkerLane) {
  // RPC is installed directly in the project DB. Cast keeps this module usable
  // before generated Supabase types are refreshed by Lovable.
  const { data, error } = await (supabaseAdmin as any).rpc("claim_scan_queue_item", {
    p_worker_id: workerId,
    p_lane: lane ?? null,
  });
  if (error) throw error;
  return Array.isArray(data) ? (data[0] ?? null) : data;
}

export async function completeTarget(queueId: string) {
  const { data, error } = await supabaseAdmin
    .from("scan_queue")
    .update({
      status: "completed",
      locked_by: null,
      locked_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", queueId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function retryTarget(queueId: string, delayMs: number) {
  const availableAt = new Date(Date.now() + Math.max(0, delayMs)).toISOString();
  const { data, error } = await supabaseAdmin
    .from("scan_queue")
    .update({
      status: "retry",
      locked_by: null,
      locked_at: null,
      available_at: availableAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", queueId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function failTarget(queueId: string) {
  const { data, error } = await supabaseAdmin
    .from("scan_queue")
    .update({
      status: "failed",
      locked_by: null,
      locked_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", queueId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}
