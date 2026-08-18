#!/usr/bin/env python3
"""Đo coverage theo danh sách brand/chuỗi thực dụng và phát sinh gap queue.

Output được dùng bởi Free Source Hunter ở vòng kế tiếp để tự ưu tiên các brand
còn thiếu hoặc đang REVIEW thay vì tiếp tục mở rộng domain ngẫu nhiên.
"""
import json
import re
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "integration" / "consumer_coverage_catalog.json"
MASTER = ROOT / "integration" / "master_input_sources_v1.jsonl"
OUT = ROOT / "integration" / "category_coverage_status.json"
GAPS = ROOT / "integration" / "missing_priority_sources.jsonl"


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read_json(path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def read_jsonl(path):
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(errors="replace").splitlines():
        try:
            rows.append(json.loads(line))
        except Exception:
            pass
    return rows


def norm(v):
    v = unicodedata.normalize("NFKD", str(v or ""))
    v = "".join(ch for ch in v if not unicodedata.combining(ch)).lower()
    return re.sub(r"[^a-z0-9]+", "", v)


def domain_norm(v):
    v = str(v or "").lower().strip().strip(".")
    if v.startswith("www."):
        v = v[4:]
    return v


def main():
    catalog = read_json(CATALOG, {"categories": []})
    rows = read_jsonl(MASTER)
    by_domain = {domain_norm(r.get("registrable_domain")): r for r in rows if r.get("registrable_domain")}
    searchable = []
    for r in rows:
        hay = " ".join([
            str(r.get("registrable_domain") or ""),
            " ".join(r.get("representative_names") or []),
        ])
        searchable.append((norm(hay), r))

    categories = []
    gap_rows = []
    overall = defaultdict(int)

    for cat in catalog.get("categories") or []:
        category = cat.get("category") or "UNKNOWN"
        category_priority = int(cat.get("priority") or 50)
        details = []
        counts = defaultdict(int)
        for target in cat.get("targets") or []:
            name = str(target.get("name") or "").strip()
            domains = [domain_norm(d) for d in (target.get("domains") or []) if domain_norm(d)]
            tier = int(target.get("tier") or 2)
            match = None
            match_mode = None
            for d in domains:
                if d in by_domain:
                    match = by_domain[d]
                    match_mode = "DOMAIN"
                    break
            if match is None and name:
                needle = norm(name)
                if len(needle) >= 5:
                    for hay, row in searchable:
                        if needle in hay:
                            match = row
                            match_mode = "NAME"
                            break

            if match:
                source_status = match.get("status") or "REVIEW_INPUT"
                if source_status == "ACTIVE_INPUT":
                    state = "ACTIVE"
                elif source_status == "DISCOVERY_ONLY":
                    state = "DISCOVERY_ONLY"
                else:
                    state = "REVIEW"
                source_id = match.get("source_id")
                matched_domain = match.get("registrable_domain")
                quality_score = int(match.get("quality_score") or 0)
            else:
                state = "MISSING"
                source_id = None
                matched_domain = None
                quality_score = 0

            counts[state] += 1
            overall[state] += 1
            detail = {
                "name": name,
                "tier": tier,
                "expected_domains": domains,
                "state": state,
                "source_id": source_id,
                "matched_domain": matched_domain,
                "match_mode": match_mode,
                "quality_score": quality_score,
            }
            details.append(detail)

            if state != "ACTIVE":
                priority = category_priority + (25 if tier == 1 else 10)
                if state == "MISSING":
                    priority += 20
                elif state == "REVIEW":
                    priority += 10
                gap_rows.append({
                    "schema": "promo.coverage_gap.v1",
                    "category": category,
                    "brand": name,
                    "tier": tier,
                    "state": state,
                    "priority": min(150, priority),
                    "expected_domains": domains,
                    "matched_domain": matched_domain,
                    "source_id": source_id,
                    "search_queries": [
                        f'"{name}" khuyến mãi Việt Nam',
                        f'"{name}" ưu đãi voucher Việt Nam',
                    ],
                    "action": "DISCOVER_OFFICIAL_SOURCE" if state == "MISSING" else "PROMOTE_WITH_EVIDENCE",
                })

        total = len(details)
        active = counts["ACTIVE"]
        discovered = active + counts["REVIEW"] + counts["DISCOVERY_ONLY"]
        categories.append({
            "category": category,
            "priority": category_priority,
            "target_count": total,
            "active_count": active,
            "review_count": counts["REVIEW"],
            "discovery_only_count": counts["DISCOVERY_ONLY"],
            "missing_count": counts["MISSING"],
            "active_coverage_pct": round(active * 100 / total, 1) if total else 0.0,
            "discovered_coverage_pct": round(discovered * 100 / total, 1) if total else 0.0,
            "targets": details,
        })

    categories.sort(key=lambda x: (x["active_coverage_pct"], -x["priority"], x["category"]))
    gap_rows.sort(key=lambda x: (-x["priority"], x["category"], x["brand"]))
    target_count = sum(overall.values())
    active_count = overall["ACTIVE"]
    discovered_count = active_count + overall["REVIEW"] + overall["DISCOVERY_ONLY"]
    report = {
        "schema": "promo.category_coverage_status.v1",
        "generated_at": now(),
        "market": catalog.get("market", "VN"),
        "goal": catalog.get("goal"),
        "target_count": target_count,
        "active_count": active_count,
        "review_count": overall["REVIEW"],
        "discovery_only_count": overall["DISCOVERY_ONLY"],
        "missing_count": overall["MISSING"],
        "active_coverage_pct": round(active_count * 100 / target_count, 1) if target_count else 0.0,
        "discovered_coverage_pct": round(discovered_count * 100 / target_count, 1) if target_count else 0.0,
        "next_priority_gaps": gap_rows[:30],
        "categories": categories,
    }
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    GAPS.write_text("".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in gap_rows), encoding="utf-8")
    print(json.dumps({
        "targets": target_count,
        "active": active_count,
        "review": overall["REVIEW"],
        "missing": overall["MISSING"],
        "active_coverage_pct": report["active_coverage_pct"],
        "gaps": len(gap_rows),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
