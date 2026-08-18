#!/usr/bin/env python3
import hashlib
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HANDOFF = ROOT / "integration" / "accesstrade_handoff_v1.jsonl"
SOURCES = ROOT / "integration" / "accesstrade_sources.jsonl"
TIKTOK = ROOT / "integration" / "accesstrade_tiktok_feed.jsonl"
STATUS = ROOT / "integration" / "accesstrade_status.json"
BASE = "https://api.accesstrade.vn"
UA = "PROMO-MASTER-AccessTrade/1.0"


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def env_int(name, default, lo, hi):
    try:
        value = int(os.getenv(name, str(default)))
    except Exception:
        value = default
    return max(lo, min(hi, value))


def tokens():
    out = []
    for name in ("ACCESSTRADE_API_TOKEN", "ACCESSTRADE_API_TOKEN_2"):
        value = (os.getenv(name) or "").strip()
        if value and value not in out:
            out.append(value)
    return out


def request_json(path, token_list, params=None, method="GET", body=None, timeout=30):
    params = params or {}
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    payload = None
    if body is not None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    last_error = None
    for token_index, token in enumerate(token_list):
        req = urllib.request.Request(
            url,
            data=payload,
            method=method,
            headers={
                "Authorization": "Token " + token,
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": UA,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                raw = response.read()
                return json.loads(raw.decode("utf-8")) if raw else {}, token_index
        except urllib.error.HTTPError as exc:
            last_error = f"HTTP_{exc.code}"
            if exc.code in (401, 403):
                continue
            if exc.code == 429:
                time.sleep(3)
                continue
            raise
        except Exception as exc:
            last_error = type(exc).__name__
            continue
    raise RuntimeError(last_error or "all_tokens_failed")


def as_list(payload):
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []
    data = payload.get("data")
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("offers", "coupons", "items", "results", "products"):
            if isinstance(data.get(key), list):
                return data[key]
    for key in ("offers", "coupons", "items", "results", "products"):
        if isinstance(payload.get(key), list):
            return payload[key]
    return []


def host_of(value):
    try:
        host = (urllib.parse.urlsplit(value or "").hostname or "").lower().strip(".")
        return host[4:] if host.startswith("www.") else host
    except Exception:
        return ""


def clean_domain(value, fallback_url=""):
    value = (value or "").strip().lower()
    if "://" in value:
        value = host_of(value)
    value = value.split("/", 1)[0].strip(".")
    if value.startswith("www."):
        value = value[4:]
    if "." not in value:
        value = host_of(fallback_url)
    return value


def merchant_name(value):
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in ("display_name", "name", "merchant_name", "login_name", "id"):
            if value.get(key):
                return str(value[key]).strip()
    return ""


def find_codes(value):
    codes = []
    def add(v):
        if not isinstance(v, str):
            return
        v = v.strip()
        if 3 <= len(v) <= 64 and v not in codes:
            codes.append(v)
    if isinstance(value, str):
        add(value)
    elif isinstance(value, dict):
        for key in ("code", "coupon_code", "voucher_code", "coupon", "voucher"):
            add(value.get(key))
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, dict):
                for key in ("code", "coupon_code", "voucher_code", "coupon", "voucher"):
                    add(item.get(key))
            else:
                add(item)
    return codes[:20]


def stable_key(prefix, *parts):
    raw = "|".join(str(x or "") for x in parts)
    return prefix + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]


def normalize_offer(item):
    if not isinstance(item, dict):
        return None
    offer_id = item.get("id") or item.get("offer_id") or item.get("uid")
    title = item.get("name") or item.get("title") or item.get("content") or "AccessTrade promotion"
    merchant = merchant_name(item.get("merchant")) or str(item.get("merchant_name") or "").strip()
    source_url = item.get("link") or item.get("url") or ""
    affiliate_url = item.get("prod_link") or item.get("aff_link") or item.get("affiliate_link") or ""
    domain = clean_domain(item.get("domain"), source_url or affiliate_url)
    codes = find_codes(item.get("coupons"))
    discount_value = item.get("discount_value")
    discount_percentage = item.get("discount_percentage") or item.get("coin_percentage")
    cap = item.get("coin_cap")
    if discount_percentage not in (None, "", 0, "0"):
        benefit_type = "PERCENT_DISCOUNT"
        benefit_value = str(discount_percentage) + "%" if "%" not in str(discount_percentage) else str(discount_percentage)
    elif discount_value not in (None, "", 0, "0"):
        benefit_type = "FIXED_DISCOUNT"
        benefit_value = str(discount_value)
    elif codes:
        benefit_type = "LITERAL_CODE_CANDIDATE"
        benefit_value = "Voucher/code from AccessTrade feed"
    else:
        benefit_type = "PROMOTION"
        benefit_value = str(item.get("content") or title)[:500]
    key = stable_key("AT|", offer_id, domain, title, item.get("start_time"), item.get("end_time"))
    return {
        "schema": "promo.candidate.v1",
        "idempotency_key": key,
        "source_worker": "PROMO AccessTrade Feed",
        "source_id": None,
        "registrable_domain": domain or None,
        "vertical": "GENERAL",
        "source_url": source_url or None,
        "affiliate_url": affiliate_url or None,
        "affiliate_network": "ACCESSTRADE",
        "affiliate_offer_id": str(offer_id) if offer_id is not None else None,
        "merchant": merchant or domain or "Unknown merchant",
        "title": str(title)[:500],
        "benefit_type": benefit_type,
        "benefit_value": benefit_value,
        "benefit_cap_vnd": cap,
        "min_spend_vnd": None,
        "start_date": item.get("start_time"),
        "end_date": item.get("end_time"),
        "eligibility": str(item.get("content") or "")[:2000] or None,
        "literal_code": codes[0] if len(codes) == 1 else None,
        "literal_code_candidates": codes,
        "status": "FEED_CANDIDATE",
        "verification_status": "AFFILIATE_FEED_UNVERIFIED",
        "evidence": "AccessTrade Publisher API feed. Must be verified against merchant/official source before production write.",
        "evidence_checked_at": now(),
        "raw_categories": item.get("categories"),
    }


def normalize_source(candidate):
    domain = candidate.get("registrable_domain")
    if not domain:
        return None
    return {
        "schema": "promo.source_hint.v1",
        "domain": domain,
        "source_url": candidate.get("source_url") or f"https://{domain}/",
        "brand": candidate.get("merchant"),
        "name": candidate.get("merchant"),
        "via": "accesstrade_offer_feed",
        "source_type": "AFFILIATE_DISCOVERED_MERCHANT",
        "observed_at": now(),
    }


def fetch_coupon_pages(token_list):
    limit = env_int("ACCESSTRADE_COUPON_LIMIT", 100, 10, 200)
    max_pages = env_int("ACCESSTRADE_COUPON_MAX_PAGES", 8, 1, 50)
    items = []
    errors = []
    token_used = set()
    for page in range(1, max_pages + 1):
        try:
            payload, idx = request_json("/v1/offers_informations/coupon", token_list, {"limit": limit, "page": page, "is_next_day_coupon": "false"})
            token_used.add(idx)
            rows = as_list(payload)
            items.extend(rows)
            if len(rows) < limit:
                break
        except Exception as exc:
            errors.append(f"coupon_page_{page}:{type(exc).__name__}:{exc}")
            break
    try:
        payload, idx = request_json("/v1/offers_informations/coupon_hot", token_list, {"limit": min(100, limit), "date": 1})
        token_used.add(idx)
        items.extend(as_list(payload))
    except Exception as exc:
        errors.append(f"coupon_hot:{type(exc).__name__}:{exc}")
    return items, errors, sorted(token_used)


def fetch_tiktok(token_list):
    if os.getenv("ACCESSTRADE_TIKTOK_ENABLED", "1").strip().lower() not in {"1", "true", "yes", "on"}:
        return [], [], []
    keywords = [x.strip() for x in os.getenv(
        "ACCESSTRADE_TIKTOK_KEYWORDS",
        "điện thoại,mỹ phẩm,mẹ và bé,thời trang,gia dụng,đồ ăn,du lịch",
    ).split(",") if x.strip()]
    limit = env_int("ACCESSTRADE_TIKTOK_LIMIT", 20, 5, 50)
    out = []
    errors = []
    token_used = set()
    for keyword in keywords[:12]:
        try:
            payload, idx = request_json(
                "/v2/tiktokshop_product_feeds",
                token_list,
                {"sort_field": "RECOMMENDED", "limit": limit, "title_keywords": keyword},
            )
            token_used.add(idx)
            for item in as_list(payload):
                if not isinstance(item, dict):
                    continue
                product_id = item.get("product_id") or item.get("id")
                product_url = item.get("product_url") or item.get("url") or item.get("product_detail_url")
                out.append({
                    "schema": "promo.accesstrade_tiktok_product.v1",
                    "observed_at": now(),
                    "keyword": keyword,
                    "product_id": str(product_id) if product_id is not None else None,
                    "title": item.get("title") or item.get("product_name") or item.get("name"),
                    "product_url": product_url,
                    "shop_name": item.get("shop_name") or item.get("seller_name"),
                    "sale_price": item.get("product_sales_price") or item.get("sale_price") or item.get("price"),
                    "original_price": item.get("original_price") or item.get("market_price"),
                    "commission": item.get("commission"),
                    "commission_rate": item.get("commission_rate"),
                    "units_sold": item.get("units_sold") or item.get("sold_count"),
                    "raw": item,
                })
        except Exception as exc:
            errors.append(f"tiktok:{keyword}:{type(exc).__name__}:{exc}")
        time.sleep(0.15)
    return out, errors, sorted(token_used)


def dedupe(rows, key):
    out = {}
    for row in rows:
        value = row.get(key)
        if value:
            out[value] = row
    return list(out.values())


def main():
    token_list = tokens()
    if not token_list:
        raise SystemExit("Missing ACCESSTRADE_API_TOKEN / ACCESSTRADE_API_TOKEN_2")

    started = now()
    raw_offers, offer_errors, offer_tokens = fetch_coupon_pages(token_list)
    candidates = []
    for item in raw_offers:
        candidate = normalize_offer(item)
        if candidate:
            candidates.append(candidate)
    candidates = dedupe(candidates, "idempotency_key")

    source_rows = []
    source_seen = set()
    for candidate in candidates:
        source = normalize_source(candidate)
        if not source or source["domain"] in source_seen:
            continue
        source_seen.add(source["domain"])
        source_rows.append(source)

    tiktok_rows, tiktok_errors, tiktok_tokens = fetch_tiktok(token_list)
    tiktok_rows = dedupe(tiktok_rows, "product_id")

    HANDOFF.write_text("".join(json.dumps(x, ensure_ascii=False, sort_keys=True) + "\n" for x in candidates), encoding="utf-8")
    SOURCES.write_text("".join(json.dumps(x, ensure_ascii=False, sort_keys=True) + "\n" for x in sorted(source_rows, key=lambda x: x["domain"])), encoding="utf-8")
    TIKTOK.write_text("".join(json.dumps(x, ensure_ascii=False, sort_keys=True) + "\n" for x in tiktok_rows), encoding="utf-8")

    status = {
        "schema": "promo.accesstrade_status.v1",
        "started_at": started,
        "generated_at": now(),
        "state": "OK" if not (offer_errors and not candidates) else "DEGRADED",
        "tokens_configured": len(token_list),
        "token_slots_used": sorted(set(offer_tokens + tiktok_tokens)),
        "raw_offer_rows": len(raw_offers),
        "candidate_count": len(candidates),
        "source_hint_count": len(source_rows),
        "tiktok_product_count": len(tiktok_rows),
        "offer_errors": offer_errors[-10:],
        "tiktok_errors": tiktok_errors[-10:],
        "production_write": False,
        "verification_required": True,
        "official_source_first": True,
    }
    STATUS.write_text(json.dumps(status, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(status, ensure_ascii=False))


if __name__ == "__main__":
    main()
