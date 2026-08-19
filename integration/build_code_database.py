#!/usr/bin/env python3
"""Build one UI-ready database of every promo literal code discovered in the repo.

The output is deliberately provenance-first: affiliate/unverified discoveries are
kept, but clearly separated from ACTIVE/verified worker handoffs so the UI can
filter safely without losing discovery coverage.
"""
from __future__ import annotations

import csv
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "data" / "promo_codes.json"
SNAPSHOT_LABEL = "19/08/2026"

CODE_KEYS = ("literal_code", "coupon_code", "voucher_code", "promo_code", "promotion_code")
ARRAY_CODE_KEYS = ("literal_code_candidates", "coupon_codes", "voucher_codes", "promo_codes")
SCAN_ROOTS = (ROOT / "integration", ROOT / "l2", ROOT / "docs" / "data")
SKIP_NAMES = {"promo_codes.json", "hourly_summary.json", "hourly_report_status.json"}
SKIP_PARTS = {"node_modules", ".git", "dist", "build", "coverage"}
PROMO_SIGNAL_KEYS = {
    "merchant", "title", "benefit_type", "benefit_value", "source_url", "affiliate_network",
    "verification_required", "evidence", "eligibility", "schema", "source_worker",
}
QUALITY_RANK = {"ACTIVE_VERIFIED": 4, "ACTIVE_REVIEW": 3, "UNVERIFIED": 2, "INACTIVE": 1, "UNKNOWN": 0}


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def clean_text(v, limit=2000):
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
    if not (2 <= len(s) <= 80):
        return None
    if any(ch in s for ch in ("\n", "\r", "\t")):
        return None
    # Reject obvious URLs, prose, hashes/tokens and placeholders.
    if "://" in s or " " in s or "{" in s or "}" in s:
        return None
    if re.fullmatch(r"[0-9]+", s) and len(s) > 10:
        return None
    if len(s) > 48 and re.fullmatch(r"[A-Za-z0-9_\-=%+/]+", s):
        return None
    if s.lower() in {"none", "null", "n/a", "unknown", "code", "voucher", "coupon"}:
        return None
    return s


def is_promo_record(obj):
    if not isinstance(obj, dict):
        return False
    schema = str(obj.get("schema") or "").lower()
    if schema.startswith("promo."):
        return True
    return len(PROMO_SIGNAL_KEYS.intersection(obj.keys())) >= 2


def quality(obj):
    status = str(obj.get("status") or obj.get("verification_status") or "").upper()
    verification_required = obj.get("verification_required") is True
    worker = str(obj.get("source_worker") or "").upper()
    affiliate = bool(obj.get("affiliate_network")) or "AFFILIATE" in worker
    if any(x in status for x in ("EXPIRED", "REJECT", "INVALID", "DEAD", "INACTIVE")):
        return "INACTIVE"
    if verification_required or affiliate or "UNVERIFIED" in status or "CANDIDATE" in status:
        return "UNVERIFIED"
    if status in {"ACTIVE", "READY", "VERIFIED", "VALID"}:
        return "ACTIVE_VERIFIED"
    if status:
        return "ACTIVE_REVIEW"
    return "UNKNOWN"


def row_for(code, obj, source_file):
    q = quality(obj)
    merchant = clean_text(obj.get("merchant") or obj.get("brand") or obj.get("merchant_name"), 300)
    title = clean_text(obj.get("title") or obj.get("name") or obj.get("promotion_name"), 500)
    source_url = clean_text(obj.get("source_url") or obj.get("url") or obj.get("landing_url"), 2000)
    identity = "|".join((str(code).upper(), (merchant or "").lower(), source_url or ""))
    return {
        "id": "CODE|" + hashlib.sha1(identity.encode("utf-8")).hexdigest()[:20],
        "code": code,
        "merchant": merchant,
        "title": title,
        "vertical": clean_text(obj.get("vertical"), 100),
        "benefit_type": clean_text(obj.get("benefit_type"), 120),
        "benefit_value": clean_text(obj.get("benefit_value"), 500),
        "benefit_cap_vnd": obj.get("benefit_cap_vnd"),
        "min_spend_vnd": obj.get("min_spend_vnd"),
        "start_date": clean_text(obj.get("start_date"), 100),
        "end_date": clean_text(obj.get("end_date"), 100),
        "eligibility": clean_text(obj.get("eligibility") or obj.get("conditions") or obj.get("condition"), 1500),
        "source_url": source_url,
        "affiliate_url": clean_text(obj.get("affiliate_url"), 2000),
        "source_worker": clean_text(obj.get("source_worker"), 200),
        "affiliate_network": clean_text(obj.get("affiliate_network"), 100),
        "source_id": clean_text(obj.get("source_id"), 200),
        "status": clean_text(obj.get("status") or obj.get("verification_status"), 150),
        "quality_tier": q,
        "ui_safe_default": q == "ACTIVE_VERIFIED",
        "verification_required": obj.get("verification_required") is True,
        "evidence": clean_text(obj.get("evidence"), 1800),
        "evidence_checked_at": clean_text(obj.get("evidence_checked_at") or obj.get("observed_at") or obj.get("generated_at"), 100),
        "source_files": [source_file],
    }


def extract_from_obj(obj, source_file, out):
    if isinstance(obj, list):
        for item in obj:
            extract_from_obj(item, source_file, out)
        return
    if not isinstance(obj, dict):
        return

    if is_promo_record(obj):
        codes = []
        for key in CODE_KEYS:
            c = clean_code(obj.get(key))
            if c and c not in codes:
                codes.append(c)
        # Generic `code` is accepted only for records that already look promotional.
        c = clean_code(obj.get("code"))
        if c and c not in codes:
            codes.append(c)
        for key in ARRAY_CODE_KEYS:
            vals = obj.get(key)
            if isinstance(vals, list):
                for v in vals:
                    c = clean_code(v)
                    if c and c not in codes:
                        codes.append(c)
        for code in codes:
            out.append(row_for(code, obj, source_file))

    # Recurse through likely payload containers so nested API structures are captured.
    for key, value in obj.items():
        if isinstance(value, (dict, list)) and key not in {"affiliate_offer", "raw", "headers", "env"}:
            extract_from_obj(value, source_file, out)


def parse_file(path):
    rel = path.relative_to(ROOT).as_posix()
    rows = []
    try:
        if path.suffix == ".jsonl":
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    extract_from_obj(json.loads(line), rel, rows)
                except Exception:
                    continue
        elif path.suffix == ".json":
            extract_from_obj(json.loads(path.read_text(encoding="utf-8", errors="replace")), rel, rows)
        elif path.suffix == ".csv":
            with path.open("r", encoding="utf-8", errors="replace", newline="") as f:
                for obj in csv.DictReader(f):
                    extract_from_obj(dict(obj), rel, rows)
    except Exception:
        return []
    return rows


def merge_rows(rows):
    merged = {}
    for row in rows:
        # Same code may legitimately exist at multiple merchants; retain merchant in the key.
        key = (row["code"].upper(), (row.get("merchant") or "").lower(), row.get("source_url") or "")
        old = merged.get(key)
        if not old:
            merged[key] = row
            continue
        files = list(dict.fromkeys((old.get("source_files") or []) + (row.get("source_files") or [])))
        if QUALITY_RANK[row["quality_tier"]] > QUALITY_RANK[old["quality_tier"]]:
            row["source_files"] = files[:30]
            merged[key] = row
        else:
            old["source_files"] = files[:30]
            # Fill missing UI fields from duplicate observations.
            for field in ("merchant", "title", "benefit_type", "benefit_value", "eligibility", "source_url", "start_date", "end_date", "evidence"):
                if not old.get(field) and row.get(field):
                    old[field] = row[field]
    return list(merged.values())


def main():
    found = []
    scanned_files = 0
    for base in SCAN_ROOTS:
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if not path.is_file() or path.name in SKIP_NAMES or path.suffix.lower() not in {".json", ".jsonl", ".csv"}:
                continue
            if any(part in SKIP_PARTS for part in path.parts):
                continue
            scanned_files += 1
            found.extend(parse_file(path))

    records = merge_rows(found)
    records.sort(key=lambda r: (-QUALITY_RANK[r["quality_tier"]], (r.get("merchant") or "").lower(), r["code"].upper()))
    by_quality = {}
    unique_codes = set()
    merchants = set()
    for r in records:
        by_quality[r["quality_tier"]] = by_quality.get(r["quality_tier"], 0) + 1
        unique_codes.add(r["code"].upper())
        if r.get("merchant"):
            merchants.add(r["merchant"].strip().lower())

    payload = {
        "schema": "promo.code_database.v1",
        "snapshot_label": SNAPSHOT_LABEL,
        "generated_at": now(),
        "ui_contract": {
            "default_filter": {"ui_safe_default": True},
            "note": "Show ACTIVE_VERIFIED by default. UNVERIFIED affiliate/candidate rows are discovery-only until official verification.",
        },
        "stats": {
            "records": len(records),
            "unique_literal_codes": len(unique_codes),
            "merchants": len(merchants),
            "structured_files_scanned": scanned_files,
            "by_quality_tier": by_quality,
        },
        "records": records,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    print(json.dumps(payload["stats"], ensure_ascii=False))


if __name__ == "__main__":
    main()
