#!/usr/bin/env python3
import json
import re
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit

from source_taxonomy import load_catalog_domains

ROOT = Path(__file__).resolve().parents[1]
MASTER = ROOT / "integration" / "master_input_sources_v1.jsonl"
DISPATCH = ROOT / "integration" / "promo_dispatch_plan_v1.jsonl"
STATUS = ROOT / "integration" / "master_input_status.json"
CATALOG = ROOT / "integration" / "consumer_coverage_catalog.json"
PROMO_PATH_RE = re.compile(r"(khuyen|uu-dai|uudai|voucher|coupon|promo|offer|deal|sale|reward|loyalty)", re.I)
STRONG_METHODS = {"curated_seed", "coverage_catalog", "seed_promo_path", "new_domain_promo", "internal_promo", "external_promo"}


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

    catalog_domains = load_catalog_domains(CATALOG)
    out = []
    dispatch = []
    counts = Counter()
    for r in rows:
        origins = set(r.get("origins") or [])
        methods = set(r.get("discovery_methods") or [])
        eps = r.get("entry_points") or []
        domain = (r.get("registrable_domain") or "").lower()
        promo_eps = [u for u in eps if PROMO_PATH_RE.search(urlsplit(u).path or "")]
        market_score = int(r.get("market_relevance_score") or 0)
        catalog_target = bool(r.get("catalog_target")) or domain in catalog_domains
        category = r.get("consumer_category") or "OTHER_CONSUMER"
        reasons = []
        score = 0

        if "PROMO_CANONICAL_EXPORT" in origins:
            score += 50
            reasons.append("canonical_promo_registry")
        if "PROMO_LEGACY_SEED" in origins:
            score += 40
            reasons.append("recovered_promo_registry")
        if catalog_target:
            score += 35
            reasons.append("consumer_catalog_target")
        if "curated_seed" in methods or "coverage_catalog" in methods:
            score += 25
            reasons.append("curated_source")
        if promo_eps:
            score += min(25, 10 + 3 * len(promo_eps))
            reasons.append("explicit_promo_entrypoint")
        if methods & STRONG_METHODS:
            score += 15
            reasons.append("strong_discovery_method")

        if market_score >= 70:
            score += 20
            reasons.append("strong_vn_market_relevance")
        elif market_score >= 40:
            score += 10
            reasons.append("vn_market_relevance")
        elif category == "OTHER_CONSUMER" and not ({"PROMO_LEGACY_SEED", "PROMO_CANONICAL_EXPORT"} & origins):
            score -= 30
            reasons.append("low_consumer_market_relevance")

        if r.get("access_class") in {"AUTHORIZED_ACCOUNT", "RESIDENTIAL_REQUIRED"}:
            # Hard access là đặc tính kỹ thuật, không còn là lý do tự động cho nguồn vào production.
            score += 8
            reasons.append("hard_access_candidate")
        if r.get("source_type") == "DISCOVERY_NODE":
            score -= 45
            reasons.append("discovery_radar")

        score = max(0, min(100, score))
        if r.get("source_type") == "DISCOVERY_NODE":
            source_status = "DISCOVERY_ONLY"
        elif score >= 35 and (market_score >= 30 or catalog_target or "PROMO_LEGACY_SEED" in origins or "PROMO_CANONICAL_EXPORT" in origins):
            source_status = "ACTIVE_INPUT"
        else:
            source_status = "REVIEW_INPUT"

        r["catalog_target"] = catalog_target
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

        priority_bonus = (score - 40) // 5
        if catalog_target:
            priority_bonus += 8
        r["crawl_priority"] = max(1, min(100, int(r.get("crawl_priority") or 50) + priority_bonus))
        out.append(r)
        dispatch.append({
            "schema": "promo.dispatch.v1",
            "source_id": r.get("source_id"),
            "registrable_domain": domain,
            "vertical": r.get("vertical"),
            "consumer_category": category,
            "access_class": r.get("access_class"),
            "source_status": source_status,
            "quality_score": score,
            "market_relevance_score": market_score,
            "catalog_target": catalog_target,
            "assigned_lane": lane,
            "priority": r["crawl_priority"],
            "status": dstatus,
        })
        counts[source_status] += 1
        counts[lane] += 1
        counts[r.get("vertical") or "UNKNOWN_VERTICAL"] += 1
        counts[category] += 1
        counts[r.get("access_class") or "UNKNOWN_ACCESS"] += 1
        if catalog_target:
            counts["CATALOG_TARGET"] += 1

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
    status["quality_gate"] = "SOURCE_QUALITY_V2_PRACTICAL_VN"
    status["taxonomy"] = "PRACTICAL_CONSUMER_V1"
    status["mode"] = "BRIDGE_SHADOW"
    status["production_write"] = False
    STATUS.write_text(json.dumps(status, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "records": len(out),
        "active": counts["ACTIVE_INPUT"],
        "review": counts["REVIEW_INPUT"],
        "discovery_only": counts["DISCOVERY_ONLY"],
        "catalog_targets": counts["CATALOG_TARGET"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
