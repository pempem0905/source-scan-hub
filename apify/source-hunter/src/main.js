import { Actor, log } from "apify";

const PROMO_HINTS = [
  "/khuyen-mai",
  "/khuyenmai",
  "/uu-dai",
  "/uudai",
  "/voucher",
  "/vouchers",
  "/promotion",
  "/promotions",
  "/promo",
  "/offers",
  "/deals",
  "/sale",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stripTracking(raw) {
  const url = new URL(raw);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    const k = key.toLowerCase();
    if (
      k.startsWith("utm_") ||
      k === "gclid" ||
      k === "fbclid" ||
      k === "clickid" ||
      k === "click_id" ||
      k === "aff" ||
      k === "aff_id" ||
      k === "affiliate_id" ||
      k === "subid" ||
      k === "sub_id"
    ) {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}

function extractCanonical(html, baseUrl) {
  const m = html.match(/<link\b[^>]*\brel=["'][^"']*canonical[^"']*["'][^>]*\bhref=["']([^"']+)["'][^>]*>/i)
    ?? html.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["'][^"']*canonical[^"']*["'][^>]*>/i);
  if (!m?.[1]) return null;
  try { return new URL(m[1], baseUrl).toString(); } catch { return null; }
}

function extractLinks(html, baseUrl, limit = 500) {
  const out = new Set();
  const re = /<a\b[^>]*\bhref=["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html)) && out.size < limit) {
    try {
      const u = new URL(m[1], baseUrl);
      if (u.protocol === "http:" || u.protocol === "https:") out.add(stripTracking(u.toString()));
    } catch {}
  }
  return [...out];
}

// Domain Expander keeps the raw href (minus the fragment): affiliate/click/ref
// params are what make the redirect resolvable to a merchant origin. Stripping
// them here would destroy the redirect before ORIGIN_RESOLVER ever sees it.
function extractRawLinks(html, baseUrl, limit = 800) {
  const out = new Set();
  const re = /<a\b[^>]*\bhref=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) && out.size < limit) {
    try {
      const u = new URL(m[1], baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      u.hash = "";
      out.add(u.toString());
    } catch {}
  }
  return [...out];
}

// Utility / social / infrastructure hosts that are never merchant origins.
const NOISE_HOST_RE =
  /(^|\.)(facebook|fb|instagram|linkedin|twitter|x|t|pinterest|tiktok|youtube|youtu|zalo|telegram|whatsapp|threads|reddit|messenger)\.(com|me|be|co|vn|net|org)$|(^|\.)(google|googleapis|googletagmanager|google-analytics|gstatic|doubleclick|googlesyndication|googleadservices)\.|(^|\.)(schema\.org|w3\.org|cloudflare\.com|cloudflareinsights\.com|jsdelivr\.net|unpkg\.com|bootstrapcdn\.com|fontawesome\.com|gravatar\.com|wordpress\.org|wp\.com|apple\.com|microsoft\.com|adobe\.com|jquery\.com|githubusercontent\.com)$|(^|\.)(apps\.apple\.com|play\.google\.com)$/i;

const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|woff2?|ttf|eot|pdf|zip|mp4|mp3|xml|rss)$/i;

// Hosts whose links are per-merchant redirects — each distinct URL is a
// different destination, so they are not collapsed to one per host.
const AFFILIATE_HOST_RE =
  /(accesstrade|adpia|masoffer|involve\.asia|invol\.co|ecomobi|interspace|shorten\.asia|isclix|admitad|awin|linksynergy|adflex|permate|leadscloud|clickbank)/i;

const AFFILIATE_PATH_RE = /\/(go|out|click|redirect|deal|link|aff|track|r)\//i;

function isAffiliateLink(u) {
  if (AFFILIATE_HOST_RE.test(u.hostname)) return true;
  if (AFFILIATE_PATH_RE.test(u.pathname)) return true;
  for (const k of u.searchParams.keys()) {
    const key = k.toLowerCase();
    if (["url", "u", "to", "target", "redirect", "dest", "aff", "aff_id", "affiliate_id", "subid", "sub_id", "clickid", "click_id", "ref"].includes(key)) {
      return true;
    }
  }
  return false;
}

async function fetchManual(url) {
  return fetch(url, {
    redirect: "manual",
    headers: {
      "user-agent": "SourceScanHubWorker/0.1 (+Vietnam market source discovery)",
      accept: "text/html,application/xhtml+xml,application/xml,text/xml,*/*;q=0.5",
    },
  });
}

async function resolveOrigin(discoveredUrl) {
  const chain = [discoveredUrl];
  let current = discoveredUrl;
  let status = null;

  for (let hop = 0; hop <= 8; hop += 1) {
    const res = await fetchManual(current);
    status = res.status;
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location) break;
      current = new URL(location, current).toString();
      chain.push(current);
      continue;
    }

    const contentType = res.headers.get("content-type") ?? "";
    let html = "";
    if (contentType.includes("text/html")) html = (await res.text()).slice(0, 256000);
    const canonical = stripTracking(extractCanonical(html, current) ?? current);
    const domain = new URL(canonical).hostname.replace(/^www\./, "").toLowerCase();

    return {
      discoveredUrl,
      finalUrl: current,
      canonicalUrl: canonical,
      canonicalDomain: domain,
      redirectChain: chain,
      httpStatus: status,
      resolutionStatus: res.status === 403 || res.status === 429 ? "blocked" : res.ok ? "resolved" : "unresolved",
      confidence: res.ok ? (chain.length > 1 ? 0.92 : 0.85) : 0.35,
    };
  }

  const canonical = stripTracking(current);
  return {
    discoveredUrl,
    finalUrl: current,
    canonicalUrl: canonical,
    canonicalDomain: new URL(canonical).hostname.replace(/^www\./, "").toLowerCase(),
    redirectChain: chain,
    httpStatus: status,
    resolutionStatus: "unresolved",
    confidence: 0.3,
    error: "redirect_limit",
  };
}

async function main() {
  const input = (await Actor.getInput()) ?? {};
  const hubBaseUrl = String(input.hubBaseUrl ?? "").replace(/\/$/, "");
  const workerToken = String(input.workerToken ?? "");
  const lane = String(input.lane ?? "ORIGIN_RESOLVER");
  const workerId = String(input.workerId ?? `${lane.toLowerCase()}-${Actor.getEnv().actorRunId ?? Date.now()}`);
  const maxItems = Math.max(1, Math.min(5000, Number(input.maxItems ?? 250)));
  const idlePollMs = Math.max(500, Number(input.idlePollMs ?? 2500));
  const emptyPollLimit = Math.max(1, Number(input.emptyPollLimit ?? 3));

  if (!hubBaseUrl || !workerToken) throw new Error("hubBaseUrl and workerToken are required");

  async function post(action, body) {
    const res = await fetch(`${hubBaseUrl}/api/source-engine/${action}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { error: text }; }
    if (!res.ok || payload?.ok === false) throw new Error(`${action} failed ${res.status}: ${payload?.error ?? text}`);
    return payload;
  }

  let requests = 0;
  let qualified = 0;
  let errors = 0;
  let count403 = 0;
  let count429 = 0;
  let emptyPolls = 0;

  const heartbeat = (status, currentJobId = null) =>
    post("heartbeat", {
      workerId,
      lane,
      status,
      requestsTotal: requests,
      qualifiedSourcesTotal: qualified,
      errorsTotal: errors,
      rate403: requests ? (count403 / requests) * 100 : 0,
      rate429: requests ? (count429 / requests) * 100 : 0,
      currentJobId,
    });

  await heartbeat("running");

  for (let i = 0; i < maxItems; i += 1) {
    const claimed = await post("claim", { workerId, lane });
    const item = claimed.item;
    const job = claimed.job;

    if (!item) {
      emptyPolls += 1;
      if (emptyPolls >= emptyPollLimit) break;
      await sleep(idlePollMs);
      continue;
    }
    emptyPolls = 0;

    try {
      if (lane === "SEARCH_DISCOVERY") {
        const query = job?.payload?.query;
        if (!query) throw new Error("SEARCH_DISCOVERY job missing payload.query");
        const result = await post("search", { query, count: 20, queueForResolution: true });
        qualified += Number(result.count ?? 0);
        requests += 1;
      } else if (lane === "ORIGIN_RESOLVER") {
        if (!item.target_url) throw new Error("ORIGIN_RESOLVER item missing target_url");
        const resolution = await resolveOrigin(item.target_url);
        requests += Math.max(1, resolution.redirectChain.length);
        if (resolution.httpStatus === 403) count403 += 1;
        if (resolution.httpStatus === 429) count429 += 1;
        if (resolution.resolutionStatus === "resolved") qualified += 1;
        await post("resolution", { resolution });
      } else if (lane === "DOMAIN_EXPANDER") {
        if (!item.target_url) throw new Error("DOMAIN_EXPANDER item missing target_url");
        const res = await fetch(item.target_url, { headers: { "user-agent": "SourceScanHubWorker/0.1" } });
        requests += 1;
        if (res.status === 403) count403 += 1;
        if (res.status === 429) count429 += 1;
        const html = (await res.text()).slice(0, 600000);
        const baseHost = new URL(item.target_url).hostname.replace(/^www\./, "");
        const links = extractLinks(html, item.target_url, 400);
        const candidates = links
          .filter((url) => {
            const u = new URL(url);
            const host = u.hostname.replace(/^www\./, "");
            const promo = PROMO_HINTS.some((hint) => u.pathname.toLowerCase().includes(hint));
            return host !== baseHost || promo;
          })
          .slice(0, 300)
          .map((url) => ({ url, sourceType: "OTHER", discoveredVia: `domain_expander:${baseHost}`, market: "VN" }));
        if (candidates.length) {
          const result = await post("candidates", { candidates });
          qualified += Number(result.count ?? 0);
        }
      } else if (lane === "SITEMAP_HUNTER") {
        if (!item.target_url) throw new Error("SITEMAP_HUNTER item missing target_url");
        const origin = new URL(item.target_url).origin;
        const urls = new Set([`${origin}/sitemap.xml`]);
        try {
          const robots = await fetch(`${origin}/robots.txt`, { headers: { "user-agent": "SourceScanHubWorker/0.1" } });
          requests += 1;
          const txt = await robots.text();
          for (const m of txt.matchAll(/^sitemap:\s*(https?:\/\/\S+)/gim)) urls.add(m[1]);
        } catch {}
        const discovered = new Set();
        for (const sitemapUrl of [...urls].slice(0, 10)) {
          try {
            const res = await fetch(sitemapUrl, { headers: { "user-agent": "SourceScanHubWorker/0.1" } });
            requests += 1;
            const xml = (await res.text()).slice(0, 2000000);
            for (const m of xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
              const url = m[1].replace(/&amp;/g, "&");
              if (PROMO_HINTS.some((hint) => url.toLowerCase().includes(hint))) discovered.add(url);
              if (discovered.size >= 500) break;
            }
          } catch {}
        }
        const candidates = [...discovered].map((url) => ({ url, sourceType: "OTHER", discoveredVia: `sitemap:${origin}`, market: "VN" }));
        if (candidates.length) {
          const result = await post("candidates", { candidates });
          qualified += Number(result.count ?? 0);
        }
      } else if (lane === "PROMO_PATH_HUNTER") {
        if (!item.target_url) throw new Error("PROMO_PATH_HUNTER item missing target_url");
        const origin = new URL(item.target_url).origin;
        const candidates = [];
        for (const path of PROMO_HINTS) {
          try {
            const url = `${origin}${path}`;
            const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "SourceScanHubWorker/0.1" } });
            requests += 1;
            if (res.status === 403) count403 += 1;
            if (res.status === 429) count429 += 1;
            if (res.ok) candidates.push({ url: res.url, sourceType: "OTHER", discoveredVia: `promo_path:${origin}`, market: "VN" });
          } catch {}
        }
        if (candidates.length) {
          const result = await post("candidates", { candidates });
          qualified += Number(result.count ?? 0);
        }
      } else {
        throw new Error(`Unsupported lane in worker v0.1: ${lane}`);
      }

      await post("complete", { queueId: item.id });
      await heartbeat("running", job?.id ?? null);
    } catch (error) {
      errors += 1;
      const message = error instanceof Error ? error.message : String(error);
      log.exception(error, `Worker item failed: ${item.id}`);
      const retryDelay = Math.min(60000, 2000 * 2 ** Math.min(errors, 5));
      try { await post("retry", { queueId: item.id, delayMs: retryDelay }); } catch {}
      await heartbeat("error", job?.id ?? null);
      if (String(message).includes("Unauthorized")) throw error;
    }
  }

  await heartbeat("idle");
  await Actor.pushData({ workerId, lane, requests, qualified, errors, rate403: requests ? (count403 / requests) * 100 : 0, rate429: requests ? (count429 / requests) * 100 : 0 });
  log.info("Source Scan Hub worker completed", { workerId, lane, requests, qualified, errors });
}

await Actor.main(main);
