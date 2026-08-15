import type { NormalizedUrl } from "./types";

const TRACKING_PARAM_EXACT = new Set([
  "aff",
  "aff_id",
  "affiliate",
  "affiliate_id",
  "clickid",
  "click_id",
  "gclid",
  "fbclid",
  "msclkid",
  "subid",
  "sub_id",
  "referrer",
]);

const TRACKING_PARAM_PREFIXES = ["utm_", "pk_", "mc_"];

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

function isTrackingParam(name: string): boolean {
  const key = name.toLowerCase();
  if (TRACKING_PARAM_EXACT.has(key)) return true;
  return TRACKING_PARAM_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function shouldDropRefParam(url: URL): boolean {
  const ref = url.searchParams.get("ref");
  if (!ref) return false;

  // Preserve ref when it appears to be a functional record identifier.
  if (/^[0-9]{1,12}$/.test(ref)) return false;
  if (/^[a-z0-9_-]{1,8}$/i.test(ref) && url.searchParams.size === 1) return false;
  return true;
}

export function normalizeUrl(rawUrl: string): NormalizedUrl {
  const parsed = new URL(rawUrl.trim());
  parsed.hash = "";
  parsed.hostname = normalizeHostname(parsed.hostname);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  const removedTrackingParams: string[] = [];
  const keys = [...parsed.searchParams.keys()];
  for (const key of keys) {
    if (isTrackingParam(key) || (key.toLowerCase() === "ref" && shouldDropRefParam(parsed))) {
      parsed.searchParams.delete(key);
      removedTrackingParams.push(key);
    }
  }

  parsed.searchParams.sort();

  // Prefer https for canonical comparison. This is only a normalized identity;
  // the resolver still records the actual final HTTP(S) URL.
  parsed.protocol = "https:";

  if (parsed.pathname !== "/") {
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "");
  }

  return {
    originalUrl: rawUrl,
    normalizedUrl: parsed.toString(),
    normalizedDomain: parsed.hostname,
    removedTrackingParams,
  };
}

export function normalizedDomain(rawUrlOrHost: string): string {
  const candidate = rawUrlOrHost.includes("://") ? rawUrlOrHost : `https://${rawUrlOrHost}`;
  return normalizeHostname(new URL(candidate).hostname);
}

export function dedupeKey(rawUrl: string): string {
  return normalizeUrl(rawUrl).normalizedUrl;
}
