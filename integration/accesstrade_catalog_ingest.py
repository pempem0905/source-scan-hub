#!/usr/bin/env python3
import hashlib
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://api.accesstrade.vn"
UA = "PROMO-MASTER-AccessTrade-Catalog/3.0"
CAMPAIGNS_OUT = ROOT / "integration" / "accesstrade_campaigns.jsonl"
OFFERS_OUT = ROOT / "integration" / "accesstrade_catalog_handoff_v1.jsonl"
DATAFEEDS_OUT = ROOT / "integration" / "accesstrade_datafeeds.jsonl"
STATUS_OUT = ROOT / "integration" / "accesstrade_catalog_status.json"


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def token_list():
    out = []
    for name in ("ACCESSTRADE_API_TOKEN", "ACCESSTRADE_API_TOKEN_2"):
        value = (os.getenv(name) or "").strip()
        if value and value not in out:
            out.append(value)
    return out


def request_one(path, token, params=None, timeout=20):
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    req = urllib.request.Request(
        url,
        method="GET",
        headers={"Authorization": "Token " + token, "Accept": "application/json", "User-Agent": UA},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw.decode("utf-8")) if raw else {}


def rows(payload):
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    if not isinstance(payload, dict):
        return []
    preferred = ("data", "items", "results", "offers", "campaigns", "products", "coupons", "merchants")
    queue = [payload[k] for k in preferred if k in payload]
    queue.extend(v for k, v in payload.items() if k not in preferred)
    seen = 0
    while queue and seen < 100:
        value = queue.pop(0)
        seen += 1
        if isinstance(value, list):
            dicts = [x for x in value if isinstance(x, dict)]
            if dicts:
                return dicts
        elif isinstance(value, dict):
            for key in preferred:
                if key in value:
                    queue.insert(0, value[key])
            queue.extend(v for k, v in value.items() if k not in preferred)
    return []


def fetch_pages_one(path, token, slot, base_params=None, max_pages=10, limit=100, page_key="page", limit_key="limit", timeout=20):
    out, errors = [], []
    ok = False
    base_params = base_params or {}
    for page in range(1, max_pages + 1):
        params = dict(base_params)
        params[page_key] = page
        params[limit_key] = limit
        try:
            payload = request_one(path, token, params, timeout=timeout)
            ok = True
            batch = rows(payload)
            for item in batch:
                item = dict(item)
                item["_access_token_slot"] = slot
                out.append(item)
            if not batch or len(batch) < limit:
                break
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                time.sleep(2)
                continue
            errors.append(f"token{slot}:{path}:page_{page}:HTTP_{exc.code}")
            break
        except Exception as exc:
            errors.append(f"token{slot}:{path}:page_{page}:{type(exc).__name__}:{exc}")
            break
    return out, errors, ok


def fetch_pages_multi(path, tokens, **kwargs):
    out, errors, used, stats = [], [], set(), {}
    for slot, token in enumerate(tokens):
        batch, err, ok = fetch_pages_one(path, token, slot, **kwargs)
        out.extend(batch)
        errors.extend(err)
        if ok:
            used.add(slot)
        stats[str(slot)] = {"api_ok": ok, "rows": len(batch)}
    return out, errors, used, stats


def request_multi(path, tokens, params=None, timeout=18):
    out, errors, used, stats = [], [], set(), {}
    for slot, token in enumerate(tokens):
        try:
            payload = request_one(path, token, params=params, timeout=timeout)
            batch = rows(payload)
            for item in batch:
                item = dict(item)
                item["_access_token_slot"] = slot
                out.append(item)
            used.add(slot)
            stats[str(slot)] = {"api_ok": True, "rows": len(batch)}
        except Exception as exc:
            errors.append(f"token{slot}:{path}:{type(exc).__name__}:{exc}")
            stats[str(slot)] = {"api_ok": False, "rows": 0}
    return out, errors, used, stats


def stable(prefix, *parts):
    raw = "|".join(str(x or "") for x in parts)
    return prefix + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]


def merchant_name(value):
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in ("display_name", "name", "merchant_name", "login_name", "id"):
            if value.get(key):
                return str(value[key]).strip()
    return ""


def normalize_campaign(item, endpoint):
    cid = str(item.get("id") or item.get("campaign_id") or "").strip()
    if not cid:
        return None
    return {
        "schema": "promo.accesstrade_campaign.v3",
        "campaign_id": cid,
        "token_slot": item.get("_access_token_slot"),
        "name": item.get("name") or item.get("campaign_name"),
        "merchant": merchant_name(item.get("merchant")) or item.get("merchant"),
        "approval": item.get("approval"),
        "status": item.get("status"),
        "category": item.get("category") or item.get("category_name"),
        "sub_category": item.get("sub_category"),
        "campaign_type": item.get("type") or item.get("campaign_type"),
        "min_commission": item.get("min_commission"),
        "max_commission": item.get("max_commission"),
        "url": item.get("url"),
        "start_time": item.get("start_time"),
        "end_time": item.get("end_time"),
        "source_endpoint": endpoint,
        "observed_at": now(),
    }


def normalize_offer(item, source_kind="active_promotions"):
    offer_id = item.get("id") or item.get("offer_id") or item.get("uid")
    merchant = merchant_name(item.get("merchant")) or str(item.get("merchant_name") or "").strip()
    title = item.get("name") or item.get("title") or item.get("content") or "AccessTrade promotion"
    domain = str(item.get("domain") or "").strip().lower()
    codes = []
    coupon_obj = item.get("coupons")
    if isinstance(coupon_obj, list):
        for c in coupon_obj:
            if isinstance(c, dict):
                value = c.get("code") or c.get("coupon_code") or c.get("voucher_code")
                if value:
                    codes.append(str(value).strip())
    elif isinstance(coupon_obj, dict):
        value = coupon_obj.get("code") or coupon_obj.get("coupon_code") or coupon_obj.get("voucher_code")
        if value:
            codes.append(str(value).strip())
    return {
        "schema": "promo.candidate.v1",
        "idempotency_key": stable("ATCAT|", offer_id, domain, merchant, title, item.get("start_time"), item.get("end_time")),
        "source_worker": "PROMO AccessTrade Catalog Feed",
        "registrable_domain": domain or None,
        "vertical": "GENERAL",
        "source_url": item.get("link") or item.get("url"),
        "affiliate_url": item.get("aff_link") or item.get("prod_link"),
        "affiliate_network": "ACCESSTRADE",
        "affiliate_offer_id": str(offer_id) if offer_id is not None else None,
        "affiliate_token_slot": item.get("_access_token_slot"),
        "merchant": merchant or domain or "Unknown merchant",
        "title": str(title)[:500],
        "benefit_type": "LITERAL_CODE_CANDIDATE" if codes else "PROMOTION",
        "benefit_value": str(item.get("content") or title)[:500],
        "benefit_cap_vnd": item.get("coin_cap"),
        "start_date": item.get("start_time"),
        "end_date": item.get("end_time"),
        "eligibility": str(item.get("content") or "")[:2000] or None,
        "literal_code": codes[0] if len(codes) == 1 else None,
        "literal_code_candidates": codes[:20],
        "status": "FEED_CANDIDATE",
        "verification_status": "AFFILIATE_FEED_UNVERIFIED",
        "requires_official_verification": True,
        "evidence": f"AccessTrade {source_kind}. Verify against merchant/official source before production write.",
        "evidence_checked_at": now(),
        "raw_categories": item.get("categories"),
    }


def normalize_datafeed(item):
    discount_rate = item.get("discount_rate")
    discount_amount = item.get("discount_amount")
    status_discount = item.get("status_discount")
    price = item.get("price")
    discount = item.get("discount")
    is_discounted = bool(status_discount) or bool(discount_rate) or bool(discount_amount)
    try:
        if price is not None and discount is not None and float(discount) < float(price):
            is_discounted = True
    except Exception:
        pass
    if not is_discounted:
        return None
    return {
        "schema": "promo.accesstrade_discounted_product.v3",
        "idempotency_key": stable("ATDF|", item.get("campaign"), item.get("domain"), item.get("product_id"), item.get("sku"), item.get("update_time")),
        "token_slot": item.get("_access_token_slot"),
        "campaign": item.get("campaign"),
        "domain": item.get("domain"),
        "category": item.get("cate") or item.get("category"),
        "name": item.get("name") or item.get("product_name"),
        "product_id": item.get("product_id"),
        "sku": item.get("sku"),
        "product_url": item.get("url"),
        "affiliate_url": item.get("aff_link"),
        "price": price,
        "discount_price": discount,
        "discount_amount": discount_amount,
        "discount_rate": discount_rate,
        "status_discount": status_discount,
        "update_time": item.get("update_time"),
        "verification_status": "AFFILIATE_FEED_UNVERIFIED",
        "requires_official_verification": True,
        "observed_at": now(),
    }


def dedupe(data, key_fn):
    out = {}
    for item in data:
        key = key_fn(item)
        if key:
            out[key] = item
    return list(out.values())


def write_jsonl(path, data):
    path.write_text("".join(json.dumps(x, ensure_ascii=False, sort_keys=True) + "\n" for x in data if x), encoding="utf-8")


def as_int(value):
    try:
        return int(float(value or 0))
    except Exception:
        return 0


def top_breakdown(rows_, field, limit=12):
    c = Counter()
    for row in rows_:
        value = row.get(field)
        if value:
            c[str(value)] += 1
    return dict(c.most_common(limit))


def main():
    tokens = token_list()
    if not tokens:
        raise SystemExit("Missing AccessTrade tokens")

    used = set()
    legacy, legacy_errors, legacy_used, legacy_stats = fetch_pages_multi(
        "/v1/campaigns", tokens, base_params={"approval": "successful"}, max_pages=20, limit=100, timeout=18
    )
    used.update(legacy_used)
    modern, modern_errors, modern_used, modern_stats = fetch_pages_multi(
        "/v1/cashback/campaigns", tokens, base_params={}, max_pages=10, limit=100, limit_key="page_size", timeout=18
    )
    used.update(modern_used)

    campaign_rows = [x for x in (normalize_campaign(i, "/v1/campaigns") for i in legacy) if x]
    campaign_rows += [x for x in (normalize_campaign(i, "/v1/cashback/campaigns") for i in modern) if x]
    campaign_rows = dedupe(campaign_rows, lambda x: f"{x.get('token_slot')}:{x.get('campaign_id')}")

    active_offers, offer_errors, offer_used, offer_stats = fetch_pages_multi(
        "/v1/offers_informations", tokens, base_params={"status": 1}, max_pages=20, limit=100, timeout=18
    )
    used.update(offer_used)

    merchant_rows, merchant_errors, merchant_used, merchant_stats = request_multi(
        "/v1/offers_informations/merchant_list", tokens, timeout=18
    )
    used.update(merchant_used)
    merchant_rows = dedupe(merchant_rows, lambda x: str(x.get("id") or x.get("login_name") or x.get("name") or x.get("domain") or ""))

    coupon_fallback, coupon_errors = [], []
    if not active_offers and merchant_rows:
        ranked = sorted(merchant_rows, key=lambda x: as_int(x.get("total_offer")), reverse=True)[:30]
        for merchant in ranked:
            merchant_id = merchant.get("id") or merchant.get("login_name")
            if not merchant_id:
                continue
            for slot, token in enumerate(tokens):
                try:
                    payload = request_one(
                        "/v1/offers_informations/coupon", token,
                        {"merchant": merchant_id, "is_next_day_coupon": "false", "limit": 100, "page": 1}, timeout=15,
                    )
                    batch = rows(payload)
                    for item in batch:
                        item = dict(item); item["_access_token_slot"] = slot; coupon_fallback.append(item)
                    used.add(slot)
                except Exception as exc:
                    coupon_errors.append(f"token{slot}:{merchant_id}:{type(exc).__name__}:{exc}")
            time.sleep(0.05)

    offer_rows = [x for x in (normalize_offer(i, "active promotions/coupon feed") for i in list(active_offers) + coupon_fallback) if x]
    offer_rows = dedupe(offer_rows, lambda x: x.get("idempotency_key"))

    datafeed_items, datafeed_errors, datafeed_used, datafeed_stats = fetch_pages_multi(
        "/v1/datafeeds", tokens, base_params={}, max_pages=5, limit=50, timeout=18
    )
    used.update(datafeed_used)

    datafeed_rows = [x for x in (normalize_datafeed(i) for i in datafeed_items) if x]
    datafeed_rows = dedupe(datafeed_rows, lambda x: x.get("idempotency_key"))

    write_jsonl(CAMPAIGNS_OUT, campaign_rows)
    write_jsonl(OFFERS_OUT, offer_rows)
    write_jsonl(DATAFEEDS_OUT, datafeed_rows)

    status = {
        "schema": "promo.accesstrade_catalog_status.v3",
        "generated_at": now(),
        "state": "OK" if offer_rows or datafeed_rows else "DEGRADED",
        "tokens_configured": len(tokens),
        "token_slots_used": sorted(used),
        "per_token": {
            "legacy_campaigns": legacy_stats,
            "modern_campaigns": modern_stats,
            "active_offers": offer_stats,
            "merchant_list": merchant_stats,
            "datafeeds": datafeed_stats,
        },
        "approved_campaign_count": len(campaign_rows),
        "legacy_campaign_rows": len(legacy),
        "modern_campaign_rows": len(modern),
        "merchant_with_offer_count": sum(1 for x in merchant_rows if as_int(x.get("total_offer")) > 0),
        "active_offer_count": len(offer_rows),
        "global_active_offer_rows": len(active_offers),
        "coupon_fallback_rows": len(coupon_fallback),
        "discounted_product_count": len(datafeed_rows),
        "campaign_category_breakdown": top_breakdown(campaign_rows, "category"),
        "top_offer_merchants": top_breakdown(offer_rows, "merchant"),
        "top_product_domains": top_breakdown(datafeed_rows, "domain"),
        "campaign_errors": (legacy_errors + modern_errors)[-12:],
        "offer_errors": (offer_errors + merchant_errors + coupon_errors)[-12:],
        "datafeed_errors": datafeed_errors[-12:],
        "production_write": False,
        "verification_required": True,
        "official_source_first": True,
    }
    STATUS_OUT.write_text(json.dumps(status, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(status, ensure_ascii=False))


if __name__ == "__main__":
    main()
