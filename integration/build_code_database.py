#!/usr/bin/env python3
"""Build one UI-ready database of explicit promo literal codes discovered in PROMO.

Only fields whose names explicitly mean voucher/promo code are accepted. Generic
`code` fields are deliberately ignored because upstream telemetry/API payloads use
that name for technical status/campaign identifiers as well.
"""
from __future__ import annotations

import csv
import hashlib
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "data" / "promo_codes.json"
STATUS_OUT = ROOT / "integration" / "code_database_status.json"
SNAPSHOT_LABEL = "19/08/2026"

CODE_KEYS = ("literal_code", "coupon_code", "voucher_code", "promo_code", "promotion_code")
ARRAY_CODE_KEYS = ("literal_code_candidates", "coupon_codes", "voucher_codes", "promo_codes")
SCAN_ROOTS = (ROOT / "integration", ROOT / "l2", ROOT / "docs" / "data")
SKIP_NAMES = {"promo_codes.json", "code_database_status.json", "hourly_summary.json", "hourly_report_status.json"}
SKIP_PARTS = {"node_modules", ".git", "dist", "build", "coverage"}
QUALITY_RANK = {"ACTIVE_VERIFIED": 4, "ACTIVE_REVIEW": 3, "UNVERIFIED": 2, "INACTIVE": 1, "UNKNOWN": 0}


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def txt(v, limit=2000):
    if v is None:
        return None
    if isinstance(v, (dict, list)):
        v = json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    s = str(v).strip()
    return s[:limit] if s else None


def clean_code(v):
    if not isinstance(v, (str, int, float)):
        return None
    s = str(v).strip()
    if not 2 <= len(s) <= 64:
        return None
    if any(c in s for c in "\n\r\t ") or "://" in s or "{" in s or "}" in s:
        return None
    if re.fullmatch(r"[0-9]+", s) and len(s) > 10:
        return None
    if len(s) > 48 and re.fullmatch(r"[A-Za-z0-9_\-=%+/]+", s):
        return None
    if s.lower() in {"none", "null", "n/a", "unknown", "code", "voucher", "coupon", "promo"}:
        return None
    return s


def quality(obj):
    status = str(obj.get("status") or obj.get("verification_status") or "").upper()
    worker = str(obj.get("source_worker") or "").upper()
    affiliate = bool(obj.get("affiliate_network")) or "AFFILIATE" in worker
    if any(x in status for x in ("EXPIRED", "REJECT", "INVALID", "DEAD", "INACTIVE")):
        return "INACTIVE"
    if obj.get("verification_required") is True or affiliate or "UNVERIFIED" in status or "CANDIDATE" in status:
        return "UNVERIFIED"
    if status in {"ACTIVE", "READY", "VERIFIED", "VALID"}:
        return "ACTIVE_VERIFIED"
    return "ACTIVE_REVIEW" if status else "UNKNOWN"


def row_for(code, obj, source_file, code_field):
    q = quality(obj)
    merchant = txt(obj.get("merchant") or obj.get("brand") or obj.get("merchant_name"), 300)
    title = txt(obj.get("title") or obj.get("name") or obj.get("promotion_name") or obj.get("offer_name"), 500)
    source_url = txt(obj.get("source_url") or obj.get("url") or obj.get("landing_url"), 2000)
    identity = "|".join((code.upper(), (merchant or "").lower(), source_url or ""))
    return {
        "id": "CODE|" + hashlib.sha1(identity.encode()).hexdigest()[:20],
        "code": code,
        "merchant": merchant,
        "title": title,
        "vertical": txt(obj.get("vertical"), 100),
        "benefit_type": txt(obj.get("benefit_type"), 120),
        "benefit_value": txt(obj.get("benefit_value"), 500),
        "benefit_cap_vnd": obj.get("benefit_cap_vnd"),
        "min_spend_vnd": obj.get("min_spend_vnd"),
        "start_date": txt(obj.get("start_date"), 100),
        "end_date": txt(obj.get("end_date"), 100),
        "eligibility": txt(obj.get("eligibility") or obj.get("conditions") or obj.get("condition"), 1500),
        "source_url": source_url,
        "affiliate_url": txt(obj.get("affiliate_url"), 2000),
        "source_worker": txt(obj.get("source_worker"), 200),
        "affiliate_network": txt(obj.get("affiliate_network"), 100),
        "source_id": txt(obj.get("source_id"), 200),
        "status": txt(obj.get("status") or obj.get("verification_status"), 150),
        "quality_tier": q,
        "ui_safe_default": q == "ACTIVE_VERIFIED",
        "verification_required": obj.get("verification_required") is True,
        "evidence": txt(obj.get("evidence"), 1800),
        "evidence_checked_at": txt(obj.get("evidence_checked_at") or obj.get("observed_at") or obj.get("generated_at"), 100),
        "code_field": code_field,
        "source_files": [source_file],
    }


def extract_obj(obj, source_file, out):
    if isinstance(obj, list):
        for x in obj:
            extract_obj(x, source_file, out)
        return
    if not isinstance(obj, dict):
        return

    seen = set()
    for key in CODE_KEYS:
        c = clean_code(obj.get(key))
        if c and c.upper() not in seen:
            seen.add(c.upper())
            out.append(row_for(c, obj, source_file, key))
    for key in ARRAY_CODE_KEYS:
        vals = obj.get(key)
        if isinstance(vals, list):
            for v in vals:
                c = clean_code(v)
                if c and c.upper() not in seen:
                    seen.add(c.upper())
                    out.append(row_for(c, obj, source_file, key))

    for key, value in obj.items():
        if isinstance(value, (dict, list)) and key not in {"affiliate_offer", "raw", "headers", "env"}:
            extract_obj(value, source_file, out)


def parse_file(path):
    rel = path.relative_to(ROOT).as_posix()
    rows = []
    try:
        if path.suffix == ".jsonl":
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                if not line.strip():
                    continue
                try:
                    extract_obj(json.loads(line), rel, rows)
                except Exception:
                    pass
        elif path.suffix == ".json":
            extract_obj(json.loads(path.read_text(encoding="utf-8", errors="replace")), rel, rows)
        elif path.suffix == ".csv":
            with path.open("r", encoding="utf-8", errors="replace", newline="") as f:
                for obj in csv.DictReader(f):
                    extract_obj(dict(obj), rel, rows)
    except Exception:
        pass
    return rows


def merge_rows(rows):
    merged = {}
    for row in rows:
        key = (row["code"].upper(), (row.get("merchant") or "").lower(), row.get("source_url") or "")
        old = merged.get(key)
        if not old:
            merged[key] = row
            continue
        files = list(dict.fromkeys(old["source_files"] + row["source_files"]))[:30]
        if QUALITY_RANK[row["quality_tier"]] > QUALITY_RANK[old["quality_tier"]]:
            row["source_files"] = files
            merged[key] = row
        else:
            old["source_files"] = files
            for f in ("merchant", "title", "benefit_type", "benefit_value", "eligibility", "source_url", "start_date", "end_date", "evidence"):
                if not old.get(f) and row.get(f):
                    old[f] = row[f]
    return list(merged.values())


def main():
    found, scanned_files = [], 0
    source_counts = Counter()
    for base in SCAN_ROOTS:
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if not path.is_file() or path.name in SKIP_NAMES or path.suffix.lower() not in {".json", ".jsonl", ".csv"}:
                continue
            if any(part in SKIP_PARTS for part in path.parts):
                continue
            scanned_files += 1
            rows = parse_file(path)
            found.extend(rows)
            if rows:
                source_counts[path.relative_to(ROOT).as_posix()] += len(rows)

    records = merge_rows(found)
    records.sort(key=lambda r: (-QUALITY_RANK[r["quality_tier"]], (r.get("merchant") or "").lower(), r["code"].upper()))
    by_quality = Counter(r["quality_tier"] for r in records)
    unique_codes = {r["code"].upper() for r in records}
    merchants = {(r.get("merchant") or "").strip().lower() for r in records if r.get("merchant")}

    stats = {
        "records": len(records),
        "unique_literal_codes": len(unique_codes),
        "merchants": len(merchants),
        "structured_files_scanned": scanned_files,
        "raw_explicit_code_observations": len(found),
        "by_quality_tier": dict(by_quality),
    }
    payload = {
        "schema": "promo.code_database.v1",
        "snapshot_label": SNAPSHOT_LABEL,
        "generated_at": now(),
        "ui_contract": {
            "default_filter": {"ui_safe_default": True},
            "note": "Show ACTIVE_VERIFIED by default. Other tiers remain visible for admin/review UI.",
        },
        "stats": stats,
        "records": records,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    qa = {
        "schema": "promo.code_database_status.v1",
        "snapshot_label": SNAPSHOT_LABEL,
        "generated_at": payload["generated_at"],
        **stats,
        "top_source_files": [{"file": k, "observations": v} for k, v in source_counts.most_common(20)],
        "sample": [{k: r.get(k) for k in ("code", "merchant", "title", "quality_tier", "status", "source_worker", "code_field")} for r in records[:30]],
    }
    STATUS_OUT.write_text(json.dumps(qa, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(stats, ensure_ascii=False))


if __name__ == "__main__":
    main()
