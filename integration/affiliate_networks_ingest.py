#!/usr/bin/env python3
"""Read-only affiliate-network ingestion for PROMO_MASTER.

Ecomobi/Passio and MasOffer are discovery feeds only. Nothing from this module
is production-trusted: every emitted candidate is marked UNVERIFIED and must
pass PROMO Turbo's official-source verification before commit.

Public provider pages confirm API support but do not expose stable endpoint/auth
contracts. The adapter therefore supports operator-provided endpoint overrides
and safe GET-only fallback probes on provider-owned hosts.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_ECOMOBI = ROOT / "integration" / "ecomobi_handoff_v1.jsonl"
OUT_MASOFFER = ROOT / "integration" / "masoffer_handoff_v1.jsonl"
STATUS = ROOT / "integration" / "affiliate_networks_status.json"
UA = "PROMO-MASTER-AffiliateFeeds/1.0"

SAFE_HOST_SUFFIXES = {
    "ECOMOBI": ("ecomobi.com", "passio.eco"),
    "MASOFFER": ("masoffer.com",),
}

DEFAULT_ENDPOINTS = {
    "ECOMOBI": [
        "https://affiliate.passio.eco/api/v1/offers",
        "https://affiliate.passio.eco/api/offers",
        "https://affiliate.passio.eco/api/v1/promotions",
        "https://affiliate.passio.eco/api/promotions",
        "https://affiliate.passio.eco/api/v1/products",
        "https://affiliate.passio.eco/api/products",
    ],
    "MASOFFER": [
        "https://api.masoffer.com/v1/promotions",
        "https://api.masoffer.com/promotions",
        "https://pub.masoffer.com/api/v1/promotions",
        "https://pub.masoffer.com/api/promotions",
        "https://pub.masoffer.com/api/promotion",
    ],
}

LIST_KEYS = (
    "data", "items", "results", "offers", "promotions", "products", "campaigns",
    "vouchers", "coupons", "records", "rows", "list",
)
CODE_KEYS = ("code", "coupon_code", "voucher_code", "promo_code", "promotion_code")
TITLE_KEYS = ("title", "name", "promotion_name", "offer_name", "product_name", "campaign_name")
MERCHANT_KEYS = ("merchant_name", "merchant", "advertiser_name", "advertiser", "brand_name", "brand", "shop_name", "shop")
URL_KEYS = ("url", "link", "landing_url", "product_url", "merchant_url", "destination_url", "deeplink")
AFF_URL_KEYS = ("affiliate_url", "tracking_url", "tracking_link", "aff_link", "affiliate_link", "short_link")
START_KEYS = ("start_time", "start_date", "starts_at", "begin_at", "valid_from")
END_KEYS = ("end_time", "end_date", "ends_at", "expired_at", "valid_to", "expiry")


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def first_value(obj, keys):
    if not isinstance(obj, dict):
        return None
    for key in keys:
        value = obj.get(key)
        if value not in (None, "", [], {}):
            if isinstance(value, dict):
                for nested in ("name", "title", "url", "link", "value", "code", "id"):
                    if value.get(nested) not in (None, ""):
                        return value[nested]
            return value
    return None


def flatten_lists(payload):
    """Return the most likely offer/product rows without exploding nested metadata."""
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    if not isinstance(payload, dict):
        return []
    for key in LIST_KEYS:
        value = payload.get(key)
        if isinstance(value, list) and value:
            rows = [x for x in value if isinstance(x, dict)]
            if rows:
                return rows
        if isinstance(value, dict):
            nested = flatten_lists(value)
            if nested:
                return nested
    return []


def xml_to_obj(raw: bytes):
    root = ET.fromstring(raw)
    rows = []
    for child in root.iter():
        grandchildren = list(child)
        if not grandchildren:
            continue
        row = {}
        for g in grandchildren:
            if list(g):
                continue
            key = g.tag.split("}")[-1]
            text = (g.text or "").strip()
            if text:
                row[key] = text
        if len(row) >= 3:
            rows.append(row)
    return rows


def parse_payload(raw: bytes, content_type: str):
    text = raw.decode("utf-8", errors="replace").strip()
    if not text:
        return {}
    if "json" in (content_type or "").lower() or text[:1] in "[{":
        return json.loads(text)
    if text.startswith("<"):
        return xml_to_obj(raw)
    raise ValueError("unsupported_payload")


def safe_endpoint(network: str, url: str) -> bool:
    try:
        p = urllib.parse.urlsplit(url)
        host = (p.hostname or "").lower().strip(".")
        if p.scheme != "https" or not host:
            return False
        return any(host == suffix or host.endswith("." + suffix) for suffix in SAFE_HOST_SUFFIXES[network])
    except Exception:
        return False


def configured_endpoints(network: str):
    raw = (os.getenv(f"{network}_API_URLS") or "").strip()
    values = [x.strip() for x in re.split(r"[\n,;]+", raw) if x.strip()] if raw else []
    candidates = values or DEFAULT_ENDPOINTS[network]
    return [x for x in candidates if safe_endpoint(network, x)][:20]


def auth_variants(network: str):
    if network == "ECOMOBI":
        key = (os.getenv("ECOMOBI_API_KEY") or "").strip()
        secret = (os.getenv("ECOMOBI_API_SECRET") or "").strip()
        alt = (os.getenv("ECOMOBI_API_TOKEN") or "").strip()
        primary = key or alt
        if not primary:
            return []
        variants = [
            {"X-API-Key": primary, **({"X-API-Secret": secret} if secret else {})},
            {"Authorization": f"Bearer {primary}", **({"X-API-Secret": secret} if secret else {})},
            {"Authorization": primary, **({"X-API-Secret": secret} if secret else {})},
        ]
        if secret and secret != primary:
            variants.append({"X-API-Key": primary, "Authorization": f"Bearer {secret}"})
        return variants

    token = (os.getenv("MASOFFER_API_TOKEN") or "").strip()
    publisher = (os.getenv("MASOFFER_PUBLISHER_TOKEN") or "").strip()
    values = []
    for value in (token, publisher):
        if value and value not in values:
            values.append(value)
    variants = []
    for value in values:
        variants.extend([
            {"Authorization": f"Bearer {value}"},
            {"Authorization": value},
            {"X-Publisher-Token": value},
            {"Publisher-Token": value},
            {"X-API-Key": value},
        ])
    # Deduplicate without logging credential values.
    out, seen = [], set()
    for item in variants:
        signature = tuple(sorted(item.keys()))
        # Same header names with a different credential are useful fallback variants.
        marker = (signature, len(out))
        if marker not in seen:
            seen.add(marker)
            out.append(item)
    return out


def request_payload(url: str, headers: dict, timeout=25):
    request_headers = {
        "Accept": "application/json, application/xml, text/xml;q=0.9, */*;q=0.2",
        "User-Agent": UA,
        **headers,
    }
    req = urllib.request.Request(url, headers=request_headers, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read(8_000_000)
        return parse_payload(raw, resp.headers.get("Content-Type", "")), resp.status


def fetch_network(network: str):
    endpoints = configured_endpoints(network)
    auths = auth_variants(network)
    if not auths:
        return [], {
            "state": "CREDENTIALS_MISSING",
            "endpoints_considered": len(endpoints),
            "successful_endpoint": None,
            "http_status": None,
            "error": None,
        }

    errors = []
    for endpoint in endpoints:
        for index, headers in enumerate(auths):
            try:
                payload, status = request_payload(endpoint, headers)
                rows = flatten_lists(payload)
                if rows:
                    return rows, {
                        "state": "OK",
                        "endpoints_considered": len(endpoints),
                        "successful_endpoint": endpoint,
                        "auth_variant": index + 1,
                        "http_status": status,
                        "error": None,
                    }
                errors.append(f"empty_payload:{urllib.parse.urlsplit(endpoint).path}")
            except urllib.error.HTTPError as exc:
                if exc.code in (401, 403, 404, 405):
                    errors.append(f"HTTP_{exc.code}:{urllib.parse.urlsplit(endpoint).path}")
                    continue
                if exc.code == 429:
                    errors.append(f"HTTP_429:{urllib.parse.urlsplit(endpoint).path}")
                    time.sleep(2)
                    continue
                errors.append(f"HTTP_{exc.code}:{urllib.parse.urlsplit(endpoint).path}")
            except Exception as exc:
                errors.append(f"{type(exc).__name__}:{urllib.parse.urlsplit(endpoint).path}")
    return [], {
        "state": "API_NOT_RESOLVED",
        "endpoints_considered": len(endpoints),
        "successful_endpoint": None,
        "http_status": None,
        "error": errors[-1] if errors else "no_endpoint_succeeded",
        "attempt_count": len(errors),
    }


def host_of(value):
    try:
        host = (urllib.parse.urlsplit(str(value or "")).hostname or "").lower().strip(".")
        return host[4:] if host.startswith("www.") else host
    except Exception:
        return ""


def stable_key(network, item, domain, title, code):
    raw_id = first_value(item, ("id", "offer_id", "promotion_id", "product_id", "campaign_id", "uid"))
    raw = "|".join(str(x or "") for x in (network, raw_id, domain, title, code, first_value(item, START_KEYS), first_value(item, END_KEYS)))
    return network[:2] + "|" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:24]


def find_codes(item):
    found = []
    if not isinstance(item, dict):
        return found
    for key in CODE_KEYS:
        value = item.get(key)
        if isinstance(value, str):
            value = value.strip()
            if 3 <= len(value) <= 64 and value not in found:
                found.append(value)
    for container_key in ("coupon", "voucher", "coupons", "vouchers"):
        value = item.get(container_key)
        seq = value if isinstance(value, list) else [value]
        for sub in seq:
            if isinstance(sub, dict):
                for key in CODE_KEYS:
                    code = sub.get(key)
                    if isinstance(code, str):
                        code = code.strip()
                        if 3 <= len(code) <= 64 and code not in found:
                            found.append(code)
    return found[:20]


def text_value(value, limit=500):
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return str(value).strip()[:limit] or None


def normalize(network: str, item: dict):
    title = text_value(first_value(item, TITLE_KEYS)) or f"{network.title()} affiliate promotion"
    merchant = text_value(first_value(item, MERCHANT_KEYS))
    source_url = text_value(first_value(item, URL_KEYS), 2000)
    affiliate_url = text_value(first_value(item, AFF_URL_KEYS), 2000)
    domain = host_of(source_url) or host_of(affiliate_url)
    codes = find_codes(item)

    discount_pct = first_value(item, ("discount_percentage", "discount_percent", "percent", "discount_rate"))
    discount_value = first_value(item, ("discount_value", "discount", "amount", "discount_amount"))
    if discount_pct not in (None, "", 0, "0"):
        benefit_type = "PERCENT_DISCOUNT_CANDIDATE"
        benefit_value = text_value(discount_pct)
    elif discount_value not in (None, "", 0, "0"):
        benefit_type = "DISCOUNT_CANDIDATE"
        benefit_value = text_value(discount_value)
    elif codes:
        benefit_type = "LITERAL_CODE_CANDIDATE"
        benefit_value = "Affiliate feed exposes voucher/promo code"
    else:
        benefit_type = "PROMOTION_CANDIDATE"
        benefit_value = text_value(first_value(item, ("description", "content", "detail", "promotion_detail"))) or title

    literal = codes[0] if len(codes) == 1 else None
    return {
        "schema": "promo.candidate.v1",
        "idempotency_key": stable_key(network, item, domain, title, literal),
        "source_worker": f"PROMO {network.title()} Feed",
        "source_id": None,
        "registrable_domain": domain or None,
        "vertical": "GENERAL",
        "source_url": source_url,
        "affiliate_url": affiliate_url,
        "affiliate_network": network,
        "merchant": merchant or domain or "Unknown merchant",
        "title": title,
        "benefit_type": benefit_type,
        "benefit_value": benefit_value,
        "benefit_cap_vnd": None,
        "min_spend_vnd": None,
        "start_date": text_value(first_value(item, START_KEYS), 100),
        "end_date": text_value(first_value(item, END_KEYS), 100),
        "eligibility": text_value(first_value(item, ("conditions", "condition", "terms", "terms_conditions", "description")), 1200),
        "literal_code": literal,
        "literal_code_candidates": codes,
        "status": "AFFILIATE_FEED_UNVERIFIED",
        "evidence": f"{network} API/feed discovery only; official merchant verification required before production commit.",
        "evidence_checked_at": now(),
        "verification_required": True,
        "production_write": False,
    }


def write_jsonl(path: Path, rows):
    unique = {}
    for row in rows:
        unique[row["idempotency_key"]] = row
    ordered = sorted(unique.values(), key=lambda r: (r.get("merchant") or "", r.get("title") or "", r["idempotency_key"]))
    path.write_text("".join(json.dumps(x, ensure_ascii=False, sort_keys=True) + "\n" for x in ordered), encoding="utf-8")
    return len(ordered)


def main():
    status = {
        "schema": "promo.affiliate_network_status.v1",
        "generated_at": now(),
        "production_write": False,
        "verification_required": True,
        "networks": {},
    }
    totals = 0
    for network, path in (("ECOMOBI", OUT_ECOMOBI), ("MASOFFER", OUT_MASOFFER)):
        raw_rows, meta = fetch_network(network)
        normalized = []
        for item in raw_rows[:5000]:
            try:
                normalized.append(normalize(network, item))
            except Exception:
                continue
        count = write_jsonl(path, normalized)
        totals += count
        status["networks"][network] = {**meta, "raw_rows": len(raw_rows), "candidate_rows": count}
    status["candidate_rows_total"] = totals
    STATUS.write_text(json.dumps(status, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(status, ensure_ascii=False))


if __name__ == "__main__":
    main()
