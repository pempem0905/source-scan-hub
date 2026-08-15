import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { authorityFor, isOfficialType, isRadarType } from "./taxonomy";
import type { OriginResolution, SourceCandidateInput, WorkerHeartbeat } from "./types";
import { normalizeUrl } from "./url-normalize";

export async function ingestCandidate(input: SourceCandidateInput) {
  const normalized = normalizeUrl(input.url);
  const sourceType = input.sourceType ?? "OTHER";

  const { data: existing, error: selectError } = await supabaseAdmin
    .from("source_candidates")
    .select("*")
    .eq("normalized_url", normalized.normalizedUrl)
    .maybeSingle();
  if (selectError) throw selectError;

  const patch = {
    domain: input.domain ?? normalized.normalizedDomain,
    url: input.url,
    normalized_url: normalized.normalizedUrl,
    source_type: sourceType,
    market: input.market ?? "VN",
    discovered_via: input.discoveredVia ?? "unknown",
    status: existing?.status ?? "candidate",
    is_radar: isRadarType(sourceType),
    is_official: isOfficialType(sourceType),
    authority_score: authorityFor(sourceType),
    merchant_id: input.merchantId ?? existing?.merchant_id ?? null,
    notes: input.notes ?? existing?.notes ?? null,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    const { data, error } = await supabaseAdmin
      .from("source_candidates")
      .update(patch)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabaseAdmin
    .from("source_candidates")
    .insert({
      ...patch,
      discovered_at: new Date().toISOString(),
      resolution_status: "pending",
      error_count: 0,
      yield_score: 0,
    })
    .select("*")
    .single();

  if (error) {
    // A concurrent worker may have inserted the same normalized URL first.
    if (error.code === "23505") {
      const { data: raced, error: racedError } = await supabaseAdmin
        .from("source_candidates")
        .select("*")
        .eq("normalized_url", normalized.normalizedUrl)
        .single();
      if (racedError) throw racedError;
      return raced;
    }
    throw error;
  }
  return data;
}

export async function applyOriginResolution(candidateId: string, resolution: OriginResolution) {
  const { data: candidate, error: readError } = await supabaseAdmin
    .from("source_candidates")
    .select("*")
    .eq("id", candidateId)
    .single();
  if (readError) throw readError;

  const now = new Date().toISOString();
  const { data: updated, error } = await supabaseAdmin
    .from("source_candidates")
    .update({
      canonical_url: resolution.canonicalUrl,
      canonical_domain: resolution.canonicalDomain,
      resolution_status: resolution.resolutionStatus,
      http_status: resolution.httpStatus,
      verified_at: resolution.resolutionStatus === "resolved" ? now : candidate.verified_at,
      last_scan_at: now,
      error_count:
        resolution.resolutionStatus === "failed" ? Number(candidate.error_count ?? 0) + 1 : candidate.error_count,
      updated_at: now,
    })
    .eq("id", candidateId)
    .select("*")
    .single();
  if (error) throw error;

  const { error: edgeError } = await supabaseAdmin.from("discovery_edges").insert({
    to_candidate_id: candidateId,
    edge_type: resolution.redirectChain.length > 1 ? "redirect_resolution" : "canonical_resolution",
    discovered_url: resolution.discoveredUrl,
    final_url: resolution.finalUrl,
    canonical_url: resolution.canonicalUrl,
    confidence: resolution.confidence,
  });
  if (edgeError) throw edgeError;

  return updated;
}

export async function promoteCandidateToSource(candidateId: string) {
  const { data: candidate, error: readError } = await supabaseAdmin
    .from("source_candidates")
    .select("*")
    .eq("id", candidateId)
    .single();
  if (readError) throw readError;

  if (!candidate.normalized_url) throw new Error("Candidate is missing normalized_url");

  const { data: existing } = await supabaseAdmin
    .from("sources")
    .select("*")
    .eq("normalized_url", candidate.normalized_url)
    .maybeSingle();
  if (existing) return existing;

  const { data: source, error } = await supabaseAdmin
    .from("sources")
    .insert({
      domain: candidate.domain,
      url: candidate.url,
      normalized_url: candidate.normalized_url,
      canonical_url: candidate.canonical_url,
      canonical_domain: candidate.canonical_domain,
      source_type: candidate.source_type,
      market: candidate.market,
      status: "verified",
      authority_score: candidate.authority_score,
      discovered_via: candidate.discovered_via,
      discovered_at: candidate.discovered_at,
      verified_at: candidate.verified_at ?? new Date().toISOString(),
      last_scan_at: candidate.last_scan_at,
      merchant_id: candidate.merchant_id,
      is_official: candidate.is_official,
      is_radar: candidate.is_radar,
      resolution_status: candidate.resolution_status,
      http_status: candidate.http_status,
      error_count: candidate.error_count,
      yield_score: candidate.yield_score,
      notes: candidate.notes,
    })
    .select("*")
    .single();
  if (error) throw error;

  await supabaseAdmin
    .from("source_candidates")
    .update({ status: "verified", updated_at: new Date().toISOString() })
    .eq("id", candidateId);

  return source;
}

export async function heartbeatWorker(input: WorkerHeartbeat) {
  const now = new Date().toISOString();
  const row = {
    worker_id: input.workerId,
    lane: input.lane,
    status: input.status,
    current_job_id: input.currentJobId ?? null,
    requests_total: input.requestsTotal ?? 0,
    qualified_sources_total: input.qualifiedSourcesTotal ?? 0,
    errors_total: input.errorsTotal ?? 0,
    rate_403: input.rate403 ?? 0,
    rate_429: input.rate429 ?? 0,
    last_heartbeat: now,
    updated_at: now,
  };

  const { data, error } = await supabaseAdmin
    .from("worker_stats")
    .upsert(row, { onConflict: "worker_id" })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function recordApiUsage(input: {
  provider: string;
  requests?: number;
  credits?: number;
  costUsd?: number;
}) {
  const usageDate = new Date().toISOString().slice(0, 10);
  const { data: existing } = await supabaseAdmin
    .from("api_usage")
    .select("*")
    .eq("provider", input.provider)
    .eq("usage_date", usageDate)
    .maybeSingle();

  const row = {
    provider: input.provider,
    usage_date: usageDate,
    requests: Number(existing?.requests ?? 0) + Number(input.requests ?? 0),
    credits: Number(existing?.credits ?? 0) + Number(input.credits ?? 0),
    cost_usd: Number(existing?.cost_usd ?? 0) + Number(input.costUsd ?? 0),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabaseAdmin
    .from("api_usage")
    .upsert(row, { onConflict: "provider,usage_date" })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}
