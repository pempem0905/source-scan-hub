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
BASE = "https://api.accesstrade.vn"
UA = "PROMO-MASTER-AccessTrade-Catalog/1.0"
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


def request_json(path, tokens, params=None, timeout=30):
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    last = None
    for idx, token in enumerate(tokens):
        req = urllib.request.Request(
            url,
            method="GET",
            headers={
                "Authorization": "Token " + token,
                "Accept": "application/json",
                "User-Agent": UA,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                return (json.loads(raw.decode("utf-8")) if raw else {}), idx
        except urllib.error.HTTPError as exc:
            last = f"HTTP_{exc.code}"
            if exc.code in (401, 403):
                continue
            if exc.code == 429:
                time.sleep(2)
                continue
            raise
        except Exception as exc:
            last = type(exc).__name__
    raise RuntimeError(last or "all_tokens_failed")


def rows(payload):
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []
    data = payload.get("data")
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("items", "results", "offers", "campaigns", "products"):
            if isinstance(data.get(key), list):
                return data[key]
    for key in ("items", "results", "offers", "campaigns", "products"):
        if isinstance(payload.get(key), list):
            return payload[key]
    return []


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


def fetch_pages(path, tokens, base_params, max_pages=10, limit=200):
    out, errors, used = [], [], set()
    for page in range(1, max_pages + 1):
        params = dict(base_params)
        params.update({"page": page, "limit": limit})
        try:
            payload, idx = request_json(path, tokens, params)
            used.add(idx)
            batch = rows(payload)
            out.extend(batch)
            if len(batch) < limit:
                break
        except Exception as exc:
            errors.append(f"{path}:page_{page}:{type(exc).__name__}:{exc}")
            break
    return out, errors, sorted(used)


def normalize_campaign(item):
    if not isinstance(item, dict):
        return None
    return {
        "schema": "promo.accesstrade_campaign.v1",
        "campaign_id": str(item.get("id") or item.get("campaign_id") or ""),
        "name": item.get("name"),
        "merchant": merchant_name(item.get("merchant")) or item.get("merchant"),
        "approval": item.get("approval"),
        "status": item.get("status"),
        "category": item.get("category"),
        "sub_category": item.get("sub_category"),
        "campaign_type": item.get("type") or item.get("campaign_type"),
        "url": item.get("url"),
        "start_time": item.get("start_time"),
        "end_time": item.get("end_time"),
        "observed_at": now(),
    }


def normalize_offer(item):
    if not isinstance(item, dict):
        return None
    offer_id = item.get("id") or item.get("offer_id")
    merchant = merchant_name(item.get("merchant")) or str(item.get("merchant_name") or "").strip()
    title = item.get("name") or item.get("title") or item.get("content") or "AccessTrade active promotion"
    domain = str(item.get("domain") or "").strip().lower()
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
        "merchant": merchant or domain or "Unknown merchant",
        "title": str(title)[:500],
        "benefit_type": "PROMOTION",
        "benefit_value": str(item.get("content") or title)[:500],
        "start_date": item.get("start_time"),
        "end_date": item.get("end_time"),
        "eligibility": str(item.get("content") or "")[:2000] or None,
        "status": "FEED_CANDIDATE",
        "verification_status": "AFFILIATE_FEED_UNVERIFIED",
        "evidence": "AccessTrade active-promotion API. Verify against merchant/official source before production write.",
        "evidence_checked_at": now(),
        "raw_categories": item.get("categories"),
    }


def normalize_datafeed(item):
    if not isinstance(item, dict):
        return None
    return {
        "schema": "promo.accesstrade_discounted_product.v1",
        "idempotency_key": stable("ATDF|", item.get("campaign"), item.get("domain"), item.get("product_id"), item.get("sku"), item.get("update_time")),
        "campaign": item.get("campaign"),
        "domain": item.get("domain"),
        "category": item.get("cate"),
        "name": item.get("name"),
        "product_id": item.get("product_id"),
        "sku": item.get("sku"),
        "product_url": item.get("url"),
        "affiliate_url": item.get("aff_link"),
        "price": item.get("price"),
        "discount_price": item.get("discount"),
        "discount_amount": item.get("discount_amount"),
        "discount_rate": item.get("discount_rate"),
        "status_discount": item.get("status_discount"),
        "update_time": item.get("update_time"),
        "verification_status": "AFFILIATE_FEED_UNVERIFIED",
        "observed_at": now(),
    }


def write_jsonl(path, data):
    path.write_text("".join(json.dumps(x, ensure_ascii=False, sort_keys=True) + "\n" for x in data if x), encoding="utf-8")


def main():
    tokens = token_list()
    if not tokens:
        raise SystemExit("Missing AccessTrade tokens")

    campaigns, campaign_errors, campaign_tokens = fetch_pages(
        "/v1/campaigns", tokens, {"approval": "successful"}, max_pages=10, limit=200
    )
    active_offers, offer_errors, offer_tokens = fetch_pages(
        "/v1/offers_informations", tokens, {"status": 1}, max_pages=10, limit=200
    )
    datafeeds, datafeed_errors, datafeed_tokens = fetch_pages(
        "/v1/datafeeds", tokens, {"status_discount": 1}, max_pages=10, limit=200
    )

    campaign_rows = [x for x in (normalize_campaign(i) for i in campaigns) if x]
    offer_rows = [x for x in (normalize_offer(i) for i in active_offers) if x]
    datafeed_rows = [x for x in (normalize_datafeed(i) for i in datafeeds) if x]

    write_jsonl(CAMPAIGNS_OUT, campaign_rows)
    write_jsonl(OFFERS_OUT, offer_rows)
    write_jsonl(DATAFEEDS_OUT, datafeed_rows)

    status = {
        "schema": "promo.accesstrade_catalog_status.v1",
        "generated_at": now(),
        "tokens_configured": len(tokens),
        "token_slots_used": sorted(set(campaign_tokens + offer_tokens + datafeed_tokens)),
        "approved_campaign_count": len(campaign_rows),
        "active_offer_count": len(offer_rows),
        "discounted_product_count": len(datafeed_rows),
        "campaign_errors": campaign_errors[-5:],
        "offer_errors": offer_errors[-5:],
        "datafeed_errors": datafeed_errors[-5:],
        "state": "OK" if (campaign_rows or offer_rows or datafeed_rows) else "DEGRADED",
        "production_write": False,
        "verification_required": True,
    }
    STATUS_OUT.write_text(json.dumps(status, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(status, ensure_ascii=False))


if __name__ == "__main__":
    main()
