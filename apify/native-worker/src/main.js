import { Actor, log } from "apify";

const PROMO_HINTS = [
  "/khuyen-mai", "/khuyenmai", "/khuyen-mai-moi", "/uu-dai", "/uudai",
  "/voucher", "/vouchers", "/promotion", "/promotions", "/promo",
  "/offers", "/offer", "/deals", "/deal", "/sale",
];
const PROMO_WORD_RE = /(khuyến\s*m[ạa]i|khuyến\s*mại|ưu\s*đãi|mã\s*giảm\s*giá|voucher|coupon|promotion|promo\s*code|offers?|deals?)/i;
const VN_RE = /(việt\s*nam|viet\s*nam|vietnam|\bvnd\b|₫|hà\s*nội|ha\s*noi|hồ\s*chí\s*minh|ho\s*chi\s*minh|tp\.?hcm|saigon)/i;
const NOISE_HOST_RE = /(^|\.)(facebook|fb|instagram|linkedin|twitter|x|pinterest|tiktok|youtube|youtu|zalo|telegram|whatsapp|threads|reddit|messenger)\.(com|me|be|co|vn|net|org)$|(^|\.)(google|googleapis|googletagmanager|google-analytics|gstatic|doubleclick|googlesyndication|googleadservices)\.|(^|\.)(schema\.org|w3\.org|cloudflare\.com|cloudflareinsights\.com|jsdelivr\.net|unpkg\.com|bootstrapcdn\.com|fontawesome\.com|gravatar\.com|wordpress\.org|wp\.com|apple\.com|microsoft\.com|adobe\.com|jquery\.com|githubusercontent\.com)$/i;
const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|woff2?|ttf|eot|pdf|zip|rar|7z|mp4|mp3|avi|mov|xml|rss)(?:$|\?)/i;
const AFFILIATE_HOST_RE = /(accesstrade|adpia|masoffer|involve\.asia|invol\.co|ecomobi|interspace|shorten\.asia|isclix|admitad|awin|linksynergy|adflex|permate|leadscloud|clickbank)/i;
const AFFILIATE_PATH_RE = /\/(go|out|click|redirect|deal|link|aff|track|r)\//i;
const RADAR_HOST_RE = /(bloggiamgia|picodi|magiamgia|giamgia|coupon|voucher|sandeal|dealhot|dealngon|ma-giam-gia|khuyenmai|khuyen-mai|accesstrade|adpia|masoffer|involve\.asia|ecomobi)/i;
const BANK_HOST_RE = /(vietcombank|vietinbank|bidv|agribank|techcombank|acb\.com\.vn|mbbank|vpbank|tpbank|sacombank|vib\.com\.vn|hdbank|ocb\.com\.vn|seabank|shb\.com\.vn|eximbank|namabank|bacabank|pvcombank|msb\.com\.vn|visa\.|mastercard\.|jcb\.|americanexpress)/i;
const PLATFORM_HOST_RE = /(shopee|lazada|tiki\.vn|sendo|tiktokshop|grab\.com|traveloka|booking\.com|agoda|klook|baemin|ahamove)/i;
const TRACKING_KEYS = new Set(["gclid", "fbclid", "clickid", "click_id", "aff", "aff_id", "affiliate_id", "subid", "sub_id"]);
const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeUrl(raw, base) {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

function normalizeUrl(raw) {
  const u = new URL(raw);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  for (const key of [...u.searchParams.keys()]) {
    const k = key.toLowerCase();
    if (k.startsWith("utm_") || TRACKING_KEYS.has(k)) u.searchParams.delete(key);
  }
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  return u.toString();
}

function hostOf(raw) {
  try { return new URL(raw).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}

function rootOf(raw) {
  const u = new URL(raw);
  return `${u.protocol}//${u.host}/`;
}

function looksPromo(raw) {
  try {
    const u = new URL(raw);
    const p = `${u.pathname}${u.search}`.toLowerCase();
    return PROMO_HINTS.some((hint) => p.includes(hint));
  } catch { return false; }
}

function marketRelevant(raw, html = "") {
  const host = hostOf(raw);
  if (host.endsWith(".vn")) return true;
  try {
    const u = new URL(raw);
    const s = `${u.pathname} ${u.search}`.toLowerCase();
    if (/\/(vn|vi-vn|vi_vn|vietnam)(\/|$)/.test(s)) return true;
  } catch {}
  return VN_RE.test(html.slice(0, 240000));
}

function sourceTypeFor(host, isRadar = false) {
  if (BANK_HOST_RE.test(host)) return "BANK_OFFICIAL";
  if (PLATFORM_HOST_RE.test(host)) return "PLATFORM_OFFICIAL";
  if (AFFILIATE_HOST_RE.test(host)) return "AFFILIATE_NETWORK";
  if (isRadar || RADAR_HOST_RE.test(host)) return "COUPON_AGGREGATOR";
  return "BRAND_OFFICIAL";
}

function authorityFor(type) {
  if (type === "BRAND_OFFICIAL" || type === "MERCHANT_OFFICIAL") return 100;
  if (type === "BANK_OFFICIAL" || type === "CARD_ISSUER_OFFICIAL") return 95;
  if (type === "MARKETPLACE_OFFICIAL" || type === "PLATFORM_OFFICIAL") return 90;
  if (type === "AFFILIATE_NETWORK") return 60;
  if (type === "COUPON_AGGREGATOR") return 40;
  if (type === "DEAL_AGGREGATOR") return 35;
  if (type === "AFFILIATE_PUBLISHER") return 30;
  if (type === "BLOG") return 20;
  return 10;
}

function isRadarUrl(raw) {
  const host = hostOf(raw);
  return RADAR_HOST_RE.test(host) || AFFILIATE_HOST_RE.test(host);
}

function isAffiliateLink(u) {
  if (AFFILIATE_HOST_RE.test(u.hostname)) return true;
  if (AFFILIATE_PATH_RE.test(u.pathname)) return true;
  for (const k of u.searchParams.keys()) {
    if (["url", "u", "to", "target", "redirect", "dest", "aff", "aff_id", "affiliate_id", "subid", "sub_id", "clickid", "click_id", "ref"].includes(k.toLowerCase())) return true;
  }
  return false;
}

function extractCanonical(html, baseUrl) {
  const m = html.match(/<link\b[^>]*\brel=["'][^"']*canonical[^"']*["'][^>]*\bhref=["']([^"']+)["'][^>]*>/i)
    ?? html.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["'][^"']*canonical[^"']*["'][^>]*>/i)
    ?? html.match(/<meta\b[^>]*\bproperty=["']og:url["'][^>]*\bcontent=["']([^"']+)["'][^>]*>/i);
  if (!m?.[1]) return null;
  return safeUrl(m[1], baseUrl)?.toString() ?? null;
}

function extractLinks(html, baseUrl, limit = 1200) {
  const out = new Set();
  const re = /<a\b[^>]*\bhref=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) && out.size < limit) {
    const u = safeUrl(m[1], baseUrl);
    if (!u) continue;
    u.hash = "";
    out.add(u.toString());
  }
  return [...out];
}

async function readLimited(res, maxBytes) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (total >= maxBytes) break;
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  return out.slice(0, maxBytes);
}

await Actor.main(async () => {
  const input = (await Actor.getInput()) ?? {};
  const workerId = String(input.workerId ?? `native-${Actor.getEnv().actorRunId ?? Date.now()}`);
  const taskQueueName = String(input.taskQueueName ?? "source-scan-native-tasks-v1");
  const masterQueueName = String(input.masterQueueName ?? "source-scan-native-master-v1");
  const masterDatasetName = String(input.masterDatasetName ?? "source-scan-native-master-events-v1");
  const evidenceDatasetName = String(input.evidenceDatasetName ?? "source-scan-native-evidence-v1");
  const runtimeStoreName = String(input.runtimeStoreName ?? "source-scan-native-runtime-v1");
  const braveSearchKey = process.env.BRAVE_SEARCH_API_KEY ?? "";
  const localConcurrency = Math.max(1, Math.min(24, Number(input.localConcurrency ?? 10)));
  const maxItems = Math.max(1, Math.min(5000, Number(input.maxItems ?? 600)));
  const maxRunMinutes = Math.max(2, Math.min(120, Number(input.maxRunMinutes ?? 20)));
  const displayBaseUrl = String(input.displayBaseUrl ?? "").replace(/\/$/, "");
  const displayToken = String(input.displayToken ?? "");
  const startedAt = Date.now();
  const deadline = startedAt + maxRunMinutes * 60_000;

  const taskQueue = await Actor.openRequestQueue(taskQueueName);
  const masterQueue = await Actor.openRequestQueue(masterQueueName);
  const masterDataset = await Actor.openDataset(masterDatasetName);
  const evidenceDataset = await Actor.openDataset(evidenceDatasetName);
  const runtimeStore = await Actor.openKeyValueStore(runtimeStoreName);

  const stats = { processed: 0, httpRequests: 0, qualified: 0, errors: 0, count403: 0, count429: 0, addedTasks: 0, newMasters: 0 };
  let stopped = false;
  let latestCcIndex = null;

  async function heartbeat(status = "running") {
    const snapshot = {
      workerId, status, localConcurrency, ...stats,
      rate403: stats.httpRequests ? (stats.count403 / stats.httpRequests) * 100 : 0,
      rate429: stats.httpRequests ? (stats.count429 / stats.httpRequests) * 100 : 0,
      startedAt: new Date(startedAt).toISOString(),
      lastHeartbeat: new Date().toISOString(),
    };
    await runtimeStore.setValue(`WORKER_${workerId}`, snapshot).catch(() => {});
    if (displayBaseUrl && displayToken) {
      fetch(`${displayBaseUrl}/api/source-engine/heartbeat`, {
        method: "POST",
        headers: { authorization: `Bearer ${displayToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          workerId: `native-${workerId}`,
          lane: "CLASSIFIER_DEDUPER",
          status: status === "stopped" ? "idle" : status,
          requestsTotal: stats.httpRequests,
          qualifiedSourcesTotal: stats.qualified,
          errorsTotal: stats.errors,
          rate403: snapshot.rate403,
          rate429: snapshot.rate429,
        }),
      }).catch(() => {});
    }
  }

  const timer = setInterval(() => heartbeat("running").catch(() => {}), 10_000);

  async function httpFetch(url, options = {}, timeoutMs = 15_000) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        redirect: options.redirect ?? "follow",
        ...options,
        signal: controller.signal,
        headers: {
          "user-agent": "SourceScanNative/1.0 (+Vietnam market source discovery)",
          accept: "text/html,application/xhtml+xml,application/xml,text/xml,text/plain,*/*;q=0.5",
          ...(options.headers ?? {}),
        },
      });
      stats.httpRequests += 1;
      if (res.status === 403) stats.count403 += 1;
      if (res.status === 429) stats.count429 += 1;
      return res;
    } finally {
      clearTimeout(t);
    }
  }

  async function fetchText(url, maxBytes = 700_000, options = {}) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await httpFetch(url, options);
        if ((res.status === 429 || res.status >= 500) && attempt < 2) {
          await sleep(600 * (2 ** attempt) + Math.floor(Math.random() * 350));
          continue;
        }
        const text = await readLimited(res, maxBytes);
        return { res, text };
      } catch (error) {
        lastError = error;
        if (attempt < 2) await sleep(500 * (2 ** attempt));
      }
    }
    throw lastError ?? new Error(`fetch failed: ${url}`);
  }

  async function enqueue(kind, rawUrl, data = {}, forefront = false) {
    const u = safeUrl(rawUrl);
    if (!u || ASSET_RE.test(u.pathname)) return false;
    const normalized = normalizeUrl(u.toString());
    const uniqueKey = `${kind}:${normalized}`;
    const result = await taskQueue.addRequest({ url: normalized, uniqueKey, userData: { kind, ...data } }, { forefront });
    if (!result.wasAlreadyPresent && !result.wasAlreadyHandled) stats.addedTasks += 1;
    return !result.wasAlreadyPresent;
  }

  async function mirrorMaster(record) {
    if (!displayBaseUrl || !displayToken) return;
    try {
      await fetch(`${displayBaseUrl}/api/source-engine/candidates`, {
        method: "POST",
        headers: { authorization: `Bearer ${displayToken}`, "content-type": "application/json" },
        body: JSON.stringify({ candidates: [{
          url: record.url,
          sourceType: record.sourceType,
          discoveredVia: `apify_native:${record.discoveredVia}`,
          market: "VN",
          notes: record.notes ?? null,
        }] }),
      });
      await fetch(`${displayBaseUrl}/api/source-engine/resolution`, {
        method: "POST",
        headers: { authorization: `Bearer ${displayToken}`, "content-type": "application/json" },
        body: JSON.stringify({ resolution: {
          discoveredUrl: record.url,
          finalUrl: record.url,
          canonicalUrl: record.url,
          canonicalDomain: record.domain,
          redirectChain: [record.url],
          httpStatus: record.httpStatus ?? 200,
          resolutionStatus: "resolved",
          confidence: record.confidence ?? 0.9,
        } }),
      });
    } catch {}
  }

  async function recordMaster(rawUrl, sourceType, discoveredVia, extra = {}) {
    const normalized = normalizeUrl(rawUrl);
    const domain = hostOf(normalized);
    if (!domain || NOISE_HOST_RE.test(domain)) return false;
    const result = await masterQueue.addRequest({
      url: normalized,
      uniqueKey: `source:${normalized}`,
      userData: { sourceType, domain, discoveredVia, market: "VN", authorityScore: authorityFor(sourceType), ...extra },
    });
    if (result.wasAlreadyPresent || result.wasAlreadyHandled) return false;
    const record = {
      event: "MASTER_SOURCE_ADDED",
      at: new Date().toISOString(),
      workerId,
      url: normalized,
      domain,
      sourceType,
      authorityScore: authorityFor(sourceType),
      discoveredVia,
      market: "VN",
      confidence: extra.confidence ?? 0.9,
      httpStatus: extra.httpStatus ?? 200,
      notes: extra.notes ?? null,
    };
    stats.newMasters += 1;
    stats.qualified += 1;
    await masterDataset.pushData(record);
    mirrorMaster(record).catch(() => {});
    return true;
  }

  async function evidence(payload) {
    await evidenceDataset.pushData({ at: new Date().toISOString(), workerId, ...payload }).catch(() => {});
  }

  async function resolveOrigin(discoveredUrl) {
    const chain = [discoveredUrl];
    let current = discoveredUrl;
    let status = null;
    let html = "";
    for (let hop = 0; hop <= 8; hop += 1) {
      const { res, text } = await fetchText(current, 300_000, { redirect: "manual" });
      status = res.status;
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("location");
        if (!location) break;
        const next = safeUrl(location, current);
        if (!next) break;
        current = next.toString();
        chain.push(current);
        continue;
      }
      if ((res.headers.get("content-type") ?? "").includes("text/html")) html = text;
      const canonical = normalizeUrl(extractCanonical(html, current) ?? current);
      return { discoveredUrl, finalUrl: current, canonicalUrl: canonical, canonicalDomain: hostOf(canonical), redirectChain: chain, httpStatus: status, ok: res.ok, html };
    }
    const canonical = normalizeUrl(current);
    return { discoveredUrl, finalUrl: current, canonicalUrl: canonical, canonicalDomain: hostOf(canonical), redirectChain: chain, httpStatus: status, ok: false, html };
  }

  async function processResolve(request) {
    const r = await resolveOrigin(request.url);
    const fromRadar = Boolean(request.userData?.fromRadar) || isRadarUrl(request.userData?.discoveredFrom ?? "");
    const radar = isRadarUrl(r.canonicalUrl);
    const promo = looksPromo(r.canonicalUrl) || looksPromo(r.finalUrl) || PROMO_WORD_RE.test(r.html.slice(0, 200000));
    const market = marketRelevant(r.canonicalUrl, r.html);
    const type = sourceTypeFor(r.canonicalDomain, radar);

    if (r.ok) {
      if (radar) await recordMaster(r.canonicalUrl, type, request.userData?.discoveredVia ?? "radar_resolution", { confidence: 0.92, httpStatus: r.httpStatus });
      else if ((promo && market) || ((BANK_HOST_RE.test(r.canonicalDomain) || PLATFORM_HOST_RE.test(r.canonicalDomain)) && market)) {
        await recordMaster(r.canonicalUrl, type, request.userData?.discoveredVia ?? "origin_resolution", { confidence: r.redirectChain.length > 1 ? 0.95 : 0.9, httpStatus: r.httpStatus });
      }

      if (!NOISE_HOST_RE.test(r.canonicalDomain) && (market || fromRadar || radar || BANK_HOST_RE.test(r.canonicalDomain) || PLATFORM_HOST_RE.test(r.canonicalDomain))) {
        const root = rootOf(r.canonicalUrl);
        await enqueue("DOMAIN_EXPAND", root, { discoveredVia: `resolved:${hostOf(request.url)}`, fromRadar: fromRadar || radar }, true);
        await enqueue("SITEMAP", root, { discoveredVia: `resolved:${hostOf(request.url)}`, fromRadar: fromRadar || radar });
        await enqueue("PROMO_PATH", root, { discoveredVia: `resolved:${hostOf(request.url)}`, fromRadar: fromRadar || radar });
        await enqueue("CC_LOOKUP", root, { discoveredVia: `resolved:${hostOf(request.url)}`, fromRadar: fromRadar || radar });
      }
    } else {
      await evidence({ event: "RESOLVE_NON_2XX", url: request.url, status: r.httpStatus, chain: r.redirectChain });
    }
  }

  async function processDomainExpand(request) {
    const { res, text: html } = await fetchText(request.url, 900_000);
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    const baseHost = hostOf(request.url);
    const radar = isRadarUrl(request.url) || Boolean(request.userData?.fromRadar);
    if (isRadarUrl(request.url)) await recordMaster(request.url, sourceTypeFor(baseHost, true), request.userData?.discoveredVia ?? "radar_seed", { confidence: 0.88, httpStatus: res.status });

    const links = extractLinks(html, request.url, 1400);
    const affiliate = [];
    const externalByHost = new Map();
    const samePromo = [];

    for (const raw of links) {
      const u = safeUrl(raw);
      if (!u || ASSET_RE.test(u.pathname)) continue;
      const h = u.hostname.replace(/^www\./, "").toLowerCase();
      if (NOISE_HOST_RE.test(h)) continue;
      if (h === baseHost) {
        if (looksPromo(u.toString()) && samePromo.length < 30) samePromo.push(u.toString());
        continue;
      }
      if (isAffiliateLink(u)) affiliate.push(u.toString());
      else if (!externalByHost.has(h)) externalByHost.set(h, u.toString());
    }

    const ordered = [...affiliate.slice(0, 120), ...[...externalByHost.values()].slice(0, 120), ...samePromo].slice(0, 220);
    for (const url of ordered) {
      await enqueue("RESOLVE", url, { discoveredVia: `domain_expand:${baseHost}`, discoveredFrom: request.url, fromRadar: radar }, true);
    }
  }

  async function processSitemap(request) {
    const origin = new URL(request.url).origin;
    const sitemapUrls = new Set([`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]);
    try {
      const { res, text } = await fetchText(`${origin}/robots.txt`, 250_000);
      if (res.ok) for (const m of text.matchAll(/^sitemap:\s*(https?:\/\/\S+)/gim)) sitemapUrls.add(m[1]);
    } catch {}

    const queue = [...sitemapUrls];
    const seen = new Set();
    let promoCount = 0;
    for (let i = 0; i < queue.length && seen.size < 12 && promoCount < 250; i += 1) {
      const sitemapUrl = queue[i];
      if (seen.has(sitemapUrl)) continue;
      seen.add(sitemapUrl);
      try {
        const { res, text: xml } = await fetchText(sitemapUrl, 2_500_000);
        if (!res.ok) continue;
        for (const m of xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
          const url = m[1].replace(/&amp;/g, "&").trim();
          if (/\.xml(?:$|\?)/i.test(url) && queue.length < 20) queue.push(url);
          else if (looksPromo(url)) {
            promoCount += 1;
            await enqueue("RESOLVE", url, { discoveredVia: `sitemap:${hostOf(request.url)}`, discoveredFrom: request.url, fromRadar: Boolean(request.userData?.fromRadar) }, true);
            if (promoCount >= 250) break;
          }
        }
      } catch {}
    }
  }

  async function processPromoPath(request) {
    const origin = new URL(request.url).origin;
    const paths = [...new Set(PROMO_HINTS.map((p) => p.replace(/s$/, "")))];
    for (const path of paths) {
      const url = `${origin}${path}`;
      try {
        const { res, text } = await fetchText(url, 280_000);
        if (!res.ok) continue;
        const final = normalizeUrl(res.url || url);
        const finalPromo = looksPromo(final) || PROMO_WORD_RE.test(text);
        if (!finalPromo || !marketRelevant(final, text)) continue;
        const type = sourceTypeFor(hostOf(final), false);
        await recordMaster(final, type, `promo_path:${hostOf(request.url)}`, { confidence: 0.94, httpStatus: res.status });
        await enqueue("RESOLVE", final, { discoveredVia: `promo_path:${hostOf(request.url)}`, discoveredFrom: request.url, fromRadar: Boolean(request.userData?.fromRadar) }, true);
      } catch {}
    }
  }

  async function getLatestCcIndex() {
    if (latestCcIndex) return latestCcIndex;
    const { res, text } = await fetchText("https://index.commoncrawl.org/collinfo.json", 250_000);
    if (!res.ok) throw new Error(`Common Crawl collinfo HTTP ${res.status}`);
    const list = JSON.parse(text);
    latestCcIndex = list?.[0]?.id ?? "CC-MAIN-2026-25";
    return latestCcIndex;
  }

  async function processCcLookup(request) {
    const domain = hostOf(request.url);
    if (!domain) return;
    const index = await getLatestCcIndex();
    const endpoint = `https://index.commoncrawl.org/${encodeURIComponent(index)}-index?url=${encodeURIComponent(domain + "/*")}&output=json&filter=status:200&collapse=urlkey&limit=300`;
    const { res, text } = await fetchText(endpoint, 1_800_000);
    if (!res.ok) return;
    let count = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row?.url && looksPromo(row.url)) {
          await enqueue("RESOLVE", row.url, { discoveredVia: `common_crawl:${domain}`, discoveredFrom: request.url, fromRadar: Boolean(request.userData?.fromRadar) }, true);
          count += 1;
          if (count >= 120) break;
        }
      } catch {}
    }
  }

  async function processBraveSearch(request) {
    if (!braveSearchKey) throw new Error("BRAVE_SEARCH_API_KEY is unavailable in Actor runtime");
    const query = String(request.userData?.query ?? "").trim();
    const offset = Math.max(0, Math.min(9, Number(request.userData?.offset ?? 0)));
    if (!query) return;
    const url = `${BRAVE_SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}&count=20&offset=${offset}&safesearch=moderate`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { headers: { accept: "application/json", "x-subscription-token": braveSearchKey, "user-agent": "SourceScanNative/1.0" }, signal: controller.signal });
      stats.httpRequests += 1;
      if (res.status === 403) stats.count403 += 1;
      if (res.status === 429) stats.count429 += 1;
      if (!res.ok) throw Object.assign(new Error(`Brave HTTP ${res.status}`), { status: res.status });
      const data = await res.json();
      const results = data?.web?.results ?? [];
      for (const item of results) {
        const u = safeUrl(item?.url);
        if (!u) continue;
        const h = u.hostname.replace(/^www\./, "").toLowerCase();
        if (NOISE_HOST_RE.test(h) || ASSET_RE.test(u.pathname)) continue;
        await enqueue("RESOLVE", u.toString(), { discoveredVia: `brave:${query}`, discoveredFrom: request.url, fromRadar: false }, true);
      }
      await evidence({ event: "BRAVE_SEARCH", query, offset, results: results.length, moreResultsAvailable: Boolean(data?.query?.more_results_available) });
    } finally { clearTimeout(t); }
  }

  async function processRequest(request) {
    const kind = String(request.userData?.kind ?? "RESOLVE");
    if (kind === "BRAVE_SEARCH") return processBraveSearch(request);
    if (kind === "DOMAIN_EXPAND") return processDomainExpand(request);
    if (kind === "SITEMAP") return processSitemap(request);
    if (kind === "PROMO_PATH") return processPromoPath(request);
    if (kind === "CC_LOOKUP") return processCcLookup(request);
    return processResolve(request);
  }

  async function runner(index) {
    let emptyPolls = 0;
    while (!stopped && Date.now() < deadline) {
      if (stats.processed >= maxItems) { stopped = true; break; }
      const request = await taskQueue.fetchNextRequest();
      if (!request) {
        emptyPolls += 1;
        if (emptyPolls >= 5) break;
        await sleep(900 + index * 20);
        continue;
      }
      emptyPolls = 0;
      try {
        await processRequest(request);
        await taskQueue.markRequestHandled(request);
        stats.processed += 1;
      } catch (error) {
        stats.errors += 1;
        const retry = Number(request.userData?.retry ?? 0);
        const status = Number(error?.status ?? 0);
        const transient = status === 403 || status === 429 || status >= 500 || error?.name === "AbortError";
        if (transient && retry < 2 && Date.now() + 3000 < deadline) {
          request.userData = { ...(request.userData ?? {}), retry: retry + 1 };
          await taskQueue.reclaimRequest(request, { forefront: false });
          await sleep(350 + retry * 500);
        } else {
          await evidence({ event: "TASK_FAILED", kind: request.userData?.kind, url: request.url, retry, error: error instanceof Error ? error.message : String(error) });
          await taskQueue.markRequestHandled(request).catch(() => {});
          stats.processed += 1;
        }
      }
    }
  }

  await heartbeat("running");
  await Promise.all(Array.from({ length: localConcurrency }, (_, i) => runner(i)));
  stopped = true;
  clearInterval(timer);
  await heartbeat("stopped");

  const taskInfo = await taskQueue.getInfo().catch(() => null);
  const masterInfo = await masterQueue.getInfo().catch(() => null);
  const output = {
    status: "COMPLETED",
    workerId,
    localConcurrency,
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    ...stats,
    taskQueue: taskInfo ? { total: taskInfo.totalRequestCount, pending: taskInfo.pendingRequestCount, handled: taskInfo.handledRequestCount } : null,
    masterSources: masterInfo?.totalRequestCount ?? null,
  };
  await Actor.pushData(output);
  log.info("Native worker complete", output);
});
