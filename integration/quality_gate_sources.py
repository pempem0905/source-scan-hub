#!/usr/bin/env python3
import json
import re
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
MASTER = ROOT / "integration" / "master_input_sources_v1.jsonl"
DISPATCH = ROOT / "integration" / "promo_dispatch_plan_v1.jsonl"
STATUS = ROOT / "integration" / "master_input_status.json"
PROMO_PATH_RE = re.compile(r"(khuyen|uu-dai|uudai|voucher|coupon|promo|offer|deal|sale|reward|loyalty)", re.I)
STRONG_METHODS = {"curated_seed", "seed_promo_path", "new_domain_promo", "internal_promo", "external_promo"}


def read_json(path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def main():
    if not MASTER.exists():
        raise SystemExit("master input missing")
    rows = []
    for line in MASTER.read_text(errors="replace").splitlines():
        try:
            rows.append(json.loads(line))
        except Exception:
            pass

    out = []
    dispatch = []
    counts = Counter()
    for r in rows:
        origins = set(r.get("origins") or [])
        methods = set(r.get("discovery_methods") or [])
        eps = r.get("entry_points") or []
        promo_eps = [u for u in eps if PROMO_PATH_RE.search(urlsplit(u).path or "")]
        reasons = []
        score = 0
        if "PROMO_CANONICAL_EXPORT" in origins:
            score += 50; reasons.append("canonical_promo_registry")
        if "PROMO_LEGACY_SEED" in origins:
            score += 40; reasons.append("recovered_promo_registry")
        if "curated_seed" in methods:
            score += 25; reasons.append("curated_source")
        if promo_eps:
            score += min(25, 10 + 3 * len(promo_eps)); reasons.append("explicit_promo_entrypoint")
        if methods & STRONG_METHODS:
            score += 15; reasons.append("strong_discovery_method")
        if r.get("access_class") in {"AUTHORIZED_ACCOUNT", "RESIDENTIAL_REQUIRED"}:
            score += 15; reasons.append("hard_access_candidate")
        if r.get("source_type") == "DISCOVERY_NODE":
            score -= 45; reasons.append("discovery_radar")

        if r.get("source_type") == "DISCOVERY_NODE":
            source_status = "DISCOVERY_ONLY"
        elif r.get("access_class") in {"AUTHORIZED_ACCOUNT", "RESIDENTIAL_REQUIRED"} and eps:
            source_status = "ACTIVE_INPUT"
        elif score >= 25:
            source_status = "ACTIVE_INPUT"
        else:
            source_status = "REVIEW_INPUT"

        score = max(0, min(100, score))
        r["quality_score"] = score
        r["quality_reasons"] = reasons
        r["status"] = source_status
        if source_status == "ACTIVE_INPUT":
            lane = "PROMO_L2" if r.get("access_class") in {"AUTHORIZED_ACCOUNT", "RESIDENTIAL_REQUIRED", "MANUAL_ONLY"} else ("PROMO_BANKS" if r.get("vertical") in {"BANK_CARD", "PAYMENT_WALLET", "TRAVEL_MOBILITY"} else "PROMO_RETAIL")
            dstatus = "ELIGIBLE"
        elif source_status == "DISCOVERY_ONLY":
            lane = "SOURCE_HUNTER"
            dstatus = "DISCOVERY_ONLY"
        else:
            lane = "SOURCE_REVIEW"
            dstatus = "HOLD_REVIEW"
        r["crawl_priority"] = max(1, min(100, int(r.get("crawl_priority") or 50) + (score - 40) // 5))
        out.append(r)
        dispatch.append({
            "schema": "promo.dispatch.v1",
            "source_id": r.get("source_id"),
            "registrable_domain": r.get("registrable_domain"),
            "vertical": r.get("vertical"),
            "access_class": r.get("access_class"),
            "source_status": source_status,
            "quality_score": score,
            "assigned_lane": lane,
            "priority": r["crawl_priority"],
            "status": dstatus,
        })
        counts[source_status] += 1
        counts[lane] += 1
        counts[r.get("vertical") or "UNKNOWN_VERTICAL"] += 1
        counts[r.get("access_class") or "UNKNOWN_ACCESS"] += 1

    out.sort(key=lambda r: (0 if r["status"] == "ACTIVE_INPUT" else 1 if r["status"] == "REVIEW_INPUT" else 2, -r["crawl_priority"], r["registrable_domain"]))
    dispatch.sort(key=lambda r: (0 if r["status"] == "ELIGIBLE" else 1 if r["status"] == "HOLD_REVIEW" else 2, -r["priority"], r["registrable_domain"]))
    MASTER.write_text("".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in out), encoding="utf-8")
    DISPATCH.write_text("".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in dispatch), encoding="utf-8")

    status = read_json(STATUS, {})
    status["counts"] = dict(sorted(counts.items()))
    status["record_count"] = len(out)
    status["active_input_count"] = counts["ACTIVE_INPUT"]
    status["review_input_count"] = counts["REVIEW_INPUT"]
    status["discovery_only_count"] = counts["DISCOVERY_ONLY"]
    status["quality_gate"] = "SOURCE_QUALITY_V1"
    status["mode"] = "BRIDGE_SHADOW"
    status["production_write"] = False
    STATUS.write_text(json.dumps(status, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"records": len(out), "active": counts["ACTIVE_INPUT"], "review": counts["REVIEW_INPUT"], "discovery_only": counts["DISCOVERY_ONLY"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
