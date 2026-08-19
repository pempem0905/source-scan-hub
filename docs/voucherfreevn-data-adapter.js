/* VoucherFreeVn data adapter
 * Purpose: keep the original UI/components untouched and swap only the data layer.
 * This module normalizes PROMO/affiliate rows into the compact card/detail shape
 * expected by the existing VoucherFreeVn UI.
 */

const TEXT = (v) => (v == null ? "" : String(v).trim());
const FIRST = (...xs) => xs.map(TEXT).find(Boolean) || "";
const ARR = (v) => Array.isArray(v) ? v : (v ? [v] : []);

export function normalizeVoucherRow(row = {}) {
  const code = FIRST(row.voucher_code, row.code, row.coupon_code, row.literal_code);
  const sourceUrl = FIRST(row.canonical_url, row.source_url, row.url, row.raw_link, row.link);
  const title = FIRST(row.title, row.offer_title, row.name, row.campaign_name, row.benefit);
  const merchant = FIRST(row.merchant, row.merchant_name, row.brand, row.source_brand, row.benefit_brand);
  const benefit = FIRST(row.benefit, row.discount, row.discount_text, row.offer_value, row.description);
  const conditions = FIRST(row.conditions, row.eligibility, row.terms, row.condition, row.min_spend);
  const payment = FIRST(row.payment_requirement, row.payment_method, row.card_requirement, row.bank);
  const geo = FIRST(row.geo, row.location, row.city, row.region);
  const validFrom = FIRST(row.start_date, row.valid_from, row.starts_at);
  const validTo = FIRST(row.end_date, row.valid_to, row.expires_at, row.expiry);
  const status = FIRST(row.status, row.state, "ACTIVE").toUpperCase();
  const sourceName = FIRST(row.source_name, row.source_brand, row.publisher, merchant);
  const confidence = Number(row.confidence ?? row.official_confidence ?? 0) || 0;

  const labels = [
    code ? "Có mã" : "Ưu đãi",
    payment,
    geo,
    status === "UPCOMING" ? "Sắp diễn ra" : "",
    status === "REVIEW" ? "Cần kiểm tra" : "",
  ].filter(Boolean);

  return {
    id: FIRST(row.id, row.offer_id, row.idempotency_key, `${merchant}|${title}|${code}|${validTo}`),
    title,
    merchant,
    benefit,
    description: FIRST(row.summary, row.description, benefit),
    code,
    hasCode: Boolean(code),
    conditions,
    payment,
    geo,
    validFrom,
    validTo,
    status,
    sourceName,
    sourceUrl,
    confidence,
    labels,
    raw: row,
  };
}

export function dedupeVoucherRows(rows = []) {
  const out = [];
  const seen = new Set();
  for (const raw of rows) {
    const item = normalizeVoucherRow(raw);
    if (!item.title && !item.code) continue;
    const key = [item.merchant, item.title, item.code, item.validTo, item.sourceUrl]
      .map((x) => TEXT(x).toLowerCase())
      .join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function rankVoucherRows(rows = []) {
  return [...rows].sort((a, b) => {
    const score = (x) =>
      (x.status === "ACTIVE" ? 100 : x.status === "UPCOMING" ? 20 : -50) +
      (x.hasCode ? 25 : 0) +
      (x.sourceUrl ? 8 : 0) +
      (x.conditions ? 5 : 0) +
      Math.min(10, Number(x.confidence || 0) * 10);
    return score(b) - score(a);
  });
}

export function parseJsonl(text = "") {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

export async function fetchRows(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const text = await res.text();
  if (/\.jsonl(?:\?|$)/i.test(url)) return parseJsonl(text);
  const data = JSON.parse(text);
  if (Array.isArray(data)) return data;
  for (const key of ["items", "offers", "deals", "vouchers", "rows", "data"]) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

export async function loadUnifiedVoucherWarehouse(urls = []) {
  const settled = await Promise.allSettled(ARR(urls).map(fetchRows));
  const rows = [];
  const errors = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") rows.push(...result.value);
    else errors.push({ url: urls[i], error: String(result.reason?.message || result.reason) });
  });
  return {
    items: rankVoucherRows(dedupeVoucherRows(rows)),
    errors,
  };
}

// Original UI contract: cards stay compact. Code/conditions/source are shown only
// after the user opens/reveals the item; no data field forces a redesign.
export function toOriginalCardModel(item) {
  const x = normalizeVoucherRow(item);
  return {
    id: x.id,
    merchant: x.merchant,
    title: x.title,
    benefit: x.benefit,
    labels: x.labels,
    compact: true,
    detail: {
      code: x.code,
      conditions: x.conditions,
      payment: x.payment,
      geo: x.geo,
      validFrom: x.validFrom,
      validTo: x.validTo,
      sourceName: x.sourceName,
      sourceUrl: x.sourceUrl,
    },
  };
}
