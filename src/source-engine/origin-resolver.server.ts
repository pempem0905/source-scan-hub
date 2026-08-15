import type { OriginResolution } from "./types";
import { normalizeUrl } from "./url-normalize";

const MAX_REDIRECTS = 8;
const HTML_LIMIT = 256_000;

function extractCanonical(html: string, baseUrl: string): string | null {
  const canonical = html.match(
    /<link\b[^>]*\brel=["'][^"']*canonical[^"']*["'][^>]*\bhref=["']([^"']+)["'][^>]*>/i,
  )?.[1] ?? html.match(
    /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["'][^"']*canonical[^"']*["'][^>]*>/i,
  )?.[1];

  if (!canonical) return null;
  try {
    return new URL(canonical, baseUrl).toString();
  } catch {
    return null;
  }
}

async function readLimitedHtml(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return "";

  const text = await response.text();
  return text.slice(0, HTML_LIMIT);
}

export async function resolveOrigin(
  discoveredUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OriginResolution> {
  const redirectChain: string[] = [discoveredUrl];
  let current = discoveredUrl;
  let lastStatus: number | null = null;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        headers: {
          "user-agent": "SourceScanHub/1.0 (+Phase1 source discovery)",
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        },
      });

      lastStatus = response.status;

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) break;
        current = new URL(location, current).toString();
        redirectChain.push(current);
        continue;
      }

      if (response.status === 403 || response.status === 429) {
        const normalized = normalizeUrl(current);
        return {
          discoveredUrl,
          finalUrl: current,
          canonicalUrl: normalized.normalizedUrl,
          canonicalDomain: normalized.normalizedDomain,
          redirectChain,
          httpStatus: response.status,
          resolutionStatus: "blocked",
          confidence: 0.45,
        };
      }

      if (!response.ok) {
        const normalized = normalizeUrl(current);
        return {
          discoveredUrl,
          finalUrl: current,
          canonicalUrl: normalized.normalizedUrl,
          canonicalDomain: normalized.normalizedDomain,
          redirectChain,
          httpStatus: response.status,
          resolutionStatus: "unresolved",
          confidence: 0.35,
        };
      }

      const html = await readLimitedHtml(response);
      const canonicalFromHtml = extractCanonical(html, current);
      const canonicalNormalized = normalizeUrl(canonicalFromHtml ?? current);

      return {
        discoveredUrl,
        finalUrl: current,
        canonicalUrl: canonicalNormalized.normalizedUrl,
        canonicalDomain: canonicalNormalized.normalizedDomain,
        redirectChain,
        httpStatus: response.status,
        resolutionStatus: "resolved",
        confidence: canonicalFromHtml ? 0.98 : redirectChain.length > 1 ? 0.92 : 0.85,
      };
    }

    const normalized = normalizeUrl(current);
    return {
      discoveredUrl,
      finalUrl: current,
      canonicalUrl: normalized.normalizedUrl,
      canonicalDomain: normalized.normalizedDomain,
      redirectChain,
      httpStatus: lastStatus,
      resolutionStatus: "unresolved",
      confidence: 0.3,
      error: `Redirect limit exceeded (${MAX_REDIRECTS})`,
    };
  } catch (error) {
    let canonicalUrl = discoveredUrl;
    let canonicalDomain = "";
    try {
      const normalized = normalizeUrl(discoveredUrl);
      canonicalUrl = normalized.normalizedUrl;
      canonicalDomain = normalized.normalizedDomain;
    } catch {
      // Keep raw URL in error result.
    }

    return {
      discoveredUrl,
      finalUrl: current,
      canonicalUrl,
      canonicalDomain,
      redirectChain,
      httpStatus: lastStatus,
      resolutionStatus: "failed",
      confidence: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
