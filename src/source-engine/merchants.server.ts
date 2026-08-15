import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { classifySourceType } from "./classify";
import { authorityFor, isOfficialType, isRadarType } from "./taxonomy";
import type { SourceType } from "./types";

/** Hosts that are never merchants, even if a radar page links to them. */
const NON_MERCHANT_RE =
  /(^|\.)(facebook|fb|instagram|linkedin|twitter|x|pinterest|tiktok|youtube|youtu|zalo|telegram|whatsapp|threads|reddit|messenger)\.[a-z.]+$|(^|\.)(google|googleapis|googletagmanager|google-analytics|gstatic|doubleclick|googlesyndication|googleadservices)\.|(^|\.)(schema\.org|w3\.org|cloudflare\.com|jsdelivr\.net|unpkg\.com|bootstrapcdn\.com|fontawesome\.com|gravatar\.com|wordpress\.org|wp\.com|apple\.com|microsoft\.com|adobe\.com|jquery\.com)$|(^|\.)(vnexpress|dantri|tuoitre|thanhnien|kenh14|zingnews|cafef|vietnamnet|24h|baomoi|soha)\./i;

const EVIDENCE_THRESHOLD = 2;

type CandidateRow = {
  id: string;
  discovered_via: string | null;
  canonical_domain: string | null;
  domain: string | null;
  source_type: string;
  merchant_id: string | null;
};

function radarRootOf(discoveredVia: string | null): string | null {
  if (!discoveredVia?.startsWith("domain_expander:")) return null;
  const host = discoveredVia.slice("domain_expander:".length).trim().toLowerCase();
  return host || null;
}

/**
 * Conservative merchant linkage for candidates found by a radar Domain Expander.
 *
 * - A canonical domain the classifier already knows (bank/marketplace/platform/
 *   radar) keeps that known type: affiliate chains landing on a known official
 *   origin are trusted immediately.
 * - Otherwise a merchant row is created/updated as `candidate`, keyed by
 *   official_domain, and only reaches `verified` + MERCHANT_OFFICIAL once at
 *   least two DISTINCT verified radar domains independently point at it.
 *
 * Idempotent: re-running for the same candidate converges on the same state.
 */
export async function applyMerchantEvidence(candidate: CandidateRow) {
  const radarRoot = radarRootOf(candidate.discovered_via);
  if (!radarRoot) return null;

  const canonicalDomain = (candidate.canonical_domain ?? candidate.domain ?? "").toLowerCase();
  if (!canonicalDomain || NON_MERCHANT_RE.test(canonicalDomain)) return null;

  // Known domains use the existing classifier and never become merchant rows.
  const knownType = classifySourceType(canonicalDomain) as SourceType;
  if (knownType !== "OTHER") {
    if (candidate.source_type === "OTHER") {
      await supabaseAdmin
        .from("source_candidates")
        .update({
          source_type: knownType,
          is_radar: isRadarType(knownType),
          is_official: isOfficialType(knownType),
          authority_score: authorityFor(knownType),
          updated_at: new Date().toISOString(),
        })
        .eq("id", candidate.id);
    }
    return { knownType, evidenceCount: 0 } as const;
  }

  // Distinct verified radar domains that independently reached this origin.
  const { data: evidenceRows, error: evidenceError } = await supabaseAdmin
    .from("source_candidates")
    .select("discovered_via")
    .eq("canonical_domain", canonicalDomain)
    .eq("resolution_status", "resolved")
    .like("discovered_via", "domain_expander:%");
  if (evidenceError) throw evidenceError;

  const roots = new Set<string>();
  for (const row of evidenceRows ?? []) {
    const root = radarRootOf(row.discovered_via);
    if (root) roots.add(root);
  }
  roots.add(radarRoot);

  const { data: radarSources, error: radarError } = await supabaseAdmin
    .from("sources")
    .select("id, domain")
    .eq("is_radar", true)
    .in("domain", [...roots]);
  if (radarError) throw radarError;

  const verifiedRoots = new Set((radarSources ?? []).map((r) => (r.domain ?? "").toLowerCase()));
  const evidenceCount = [...roots].filter((r) => verifiedRoots.has(r)).length;
  const strong = evidenceCount >= EVIDENCE_THRESHOLD;

  // Dedupe merchant rows by official_domain.
  const { data: existingMerchant, error: merchantReadError } = await supabaseAdmin
    .from("merchants")
    .select("*")
    .eq("official_domain", canonicalDomain)
    .maybeSingle();
  if (merchantReadError) throw merchantReadError;

  let merchantId = existingMerchant?.id ?? null;
  const merchantPatch = {
    name: existingMerchant?.name ?? canonicalDomain,
    normalized_name: canonicalDomain,
    official_domain: canonicalDomain,
    market: "VN",
    status: strong ? "verified" : (existingMerchant?.status ?? "candidate"),
    updated_at: new Date().toISOString(),
  };

  if (merchantId) {
    const { error } = await supabaseAdmin.from("merchants").update(merchantPatch).eq("id", merchantId);
    if (error) throw error;
  } else {
    const { data, error } = await supabaseAdmin.from("merchants").insert(merchantPatch).select("id").single();
    if (error) {
      if (error.code !== "23505") throw error;
      const { data: raced } = await supabaseAdmin
        .from("merchants")
        .select("id")
        .eq("official_domain", canonicalDomain)
        .single();
      merchantId = raced?.id ?? null;
    } else {
      merchantId = data.id;
    }
  }

  // Evidence edge: radar source -> candidate.
  const radarSourceId = (radarSources ?? []).find((r) => (r.domain ?? "").toLowerCase() === radarRoot)?.id ?? null;
  if (radarSourceId) {
    const { data: edge } = await supabaseAdmin
      .from("discovery_edges")
      .select("id")
      .eq("from_source_id", radarSourceId)
      .eq("to_candidate_id", candidate.id)
      .eq("edge_type", "radar_merchant_evidence")
      .maybeSingle();
    if (!edge) {
      await supabaseAdmin.from("discovery_edges").insert({
        from_source_id: radarSourceId,
        to_candidate_id: candidate.id,
        edge_type: "radar_merchant_evidence",
        confidence: strong ? 0.9 : 0.5,
      });
    }
  }

  const patch: Record<string, unknown> = { merchant_id: merchantId, updated_at: new Date().toISOString() };
  if (strong && candidate.source_type === "OTHER") {
    patch["source_type"] = "MERCHANT_OFFICIAL";
    patch["is_official"] = true;
    patch["is_radar"] = false;
    patch["authority_score"] = authorityFor("MERCHANT_OFFICIAL");
  }
  const { error: patchError } = await supabaseAdmin
    .from("source_candidates")
    .update(patch)
    .eq("id", candidate.id);
  if (patchError) throw patchError;

  return { knownType: null, evidenceCount, merchantId, strong } as const;
}
