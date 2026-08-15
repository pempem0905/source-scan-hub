import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { applyOriginResolution } from "./store.server";
import type { OriginResolution } from "./types";
import { normalizeUrl } from "./url-normalize";

export async function applyOriginResolutionByUrl(
  candidateId: string | null | undefined,
  resolution: OriginResolution,
) {
  if (candidateId) return applyOriginResolution(candidateId, resolution);

  const normalized = normalizeUrl(resolution.discoveredUrl);
  const { data: candidate, error } = await supabaseAdmin
    .from("source_candidates")
    .select("id")
    .eq("normalized_url", normalized.normalizedUrl)
    .maybeSingle();
  if (error) throw error;
  if (!candidate) throw new Error(`No candidate found for ${resolution.discoveredUrl}`);

  return applyOriginResolution(candidate.id, resolution);
}
