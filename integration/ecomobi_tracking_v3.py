#!/usr/bin/env python3
"""Verify the Ecomobi/Ecotrackings publisher API without persisting conversion rows.

The publisher documentation exposes Token + Token Private and the read-only
GET /api/v3/conversions endpoint. This module uses that endpoint only as an
auth/API-health lane. It is NOT an offer/voucher feed and never writes
conversion/order records into the repository.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATUS = ROOT / "integration" / "ecomobi_tracking_status.json"
ENDPOINT = "https://api.ecotrackings.com/api/v3/conversions"
UA = "PROMO-MASTER-Ecomobi-Tracking/3.0"


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def credentials():
    token = (os.getenv("ECOMOBI_TOKEN") or os.getenv("ECOMOBI_API_TOKEN") or "").strip()
    private = (os.getenv("ECOMOBI_TOKEN_PRIVATE") or os.getenv("ECOMOBI_API_SECRET") or "").strip()
    return token, private


def extract_rows(payload):
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("data", "items", "results", "conversions", "records", "rows", "list"):
        value = payload.get(key)
        if isinstance(value, list):
            return [x for x in value if isinstance(x, dict)]
        if isinstance(value, dict):
            rows = extract_rows(value)
            if rows:
                return rows
    return []


def request_json(token, private, variant):
    start = (date.today() - timedelta(days=7)).isoformat()
    end = date.today().isoformat()
    params = {"token_private": private, "start_date": start, "end_date": end, "limit": 100, "page": 1}
    headers = {"Accept": "application/json", "User-Agent": UA}

    if variant == 1:
        headers["Authorization"] = "Bearer " + token
    elif variant == 2:
        headers["Authorization"] = token
    elif variant == 3:
        headers["Token"] = token
    elif variant == 4:
        params["token"] = token

    url = ENDPOINT + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, method="GET", headers=headers)
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read(4_000_000)
        text = raw.decode("utf-8", errors="replace").strip()
        if not text:
            return {}, resp.status
        return json.loads(text), resp.status


def summarize(rows):
    advertisers = {}
    statuses = {}
    for row in rows:
        advertiser = row.get("advertiser_name") or row.get("advertiser") or row.get("campaign_name") or row.get("campaign")
        if isinstance(advertiser, dict):
            advertiser = advertiser.get("name") or advertiser.get("title") or advertiser.get("id")
        if advertiser:
            key = str(advertiser)[:120]
            advertisers[key] = advertisers.get(key, 0) + 1
        state = row.get("status") or row.get("conversion_status")
        if state is not None:
            key = str(state)[:80]
            statuses[key] = statuses.get(key, 0) + 1
    top_adv = dict(sorted(advertisers.items(), key=lambda kv: kv[1], reverse=True)[:10])
    return top_adv, statuses


def main():
    token, private = credentials()
    if not token or not private:
        status = {
            "schema": "promo.ecomobi_tracking_status.v3",
            "generated_at": now(),
            "state": "CREDENTIALS_INCOMPLETE",
            "token_present": bool(token),
            "token_private_present": bool(private),
            "endpoint": "/api/v3/conversions",
            "purpose": "tracking_auth_health_only",
            "conversion_rows_persisted": False,
        }
        STATUS.write_text(json.dumps(status, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(json.dumps(status, ensure_ascii=False))
        return

    errors = []
    payload = None
    http_status = None
    successful_variant = None
    for variant in range(1, 5):
        try:
            payload, http_status = request_json(token, private, variant)
            successful_variant = variant
            break
        except urllib.error.HTTPError as exc:
            errors.append(f"variant_{variant}:HTTP_{exc.code}")
        except Exception as exc:
            errors.append(f"variant_{variant}:{type(exc).__name__}")

    rows = extract_rows(payload) if payload is not None else []
    top_adv, states = summarize(rows)
    # A valid JSON response with zero rows is still proof that auth/API resolved.
    resolved = payload is not None and http_status is not None and 200 <= int(http_status) < 300
    status = {
        "schema": "promo.ecomobi_tracking_status.v3",
        "generated_at": now(),
        "state": "OK" if resolved else "AUTH_NOT_RESOLVED",
        "endpoint": "/api/v3/conversions",
        "http_status": http_status,
        "successful_auth_variant": successful_variant,
        "recent_conversion_rows": len(rows),
        "top_advertisers_sample": top_adv,
        "status_breakdown_sample": states,
        "window_days": 7,
        "purpose": "tracking_auth_health_only",
        "conversion_rows_persisted": False,
        "last_error": errors[-1] if errors else None,
    }
    STATUS.write_text(json.dumps(status, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in status.items() if k != "top_advertisers_sample"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
