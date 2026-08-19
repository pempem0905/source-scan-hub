#!/usr/bin/env python3
"""Build sanitized L2 hard-only outcome metrics from non-secret repo state."""
from __future__ import annotations
import datetime as dt
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load_json(name: str, default):
    try:
        return json.loads((ROOT / name).read_text())
    except Exception:
        return default


def latest_timestamp(*values):
    """Return the latest parseable ISO-8601 timestamp without exposing runtime secrets."""
    parsed = []
    for value in values:
        if not value:
            continue
        try:
            parsed.append((dt.datetime.fromisoformat(str(value).replace("Z", "+00:00")), str(value)))
        except Exception:
            continue
    if not parsed:
        return None
    return max(parsed, key=lambda item: item[0])[1]


def main() -> None:
    auth = load_json("auth-status.json", {})
    hard = load_json("hard-outcomes.json", {})
    bridge = load_json("bridge-status.json", {})
    runtime = load_json("bridge-runtime-status.json", {})
    platforms = auth.get("platforms") or {}

    login_ready_states = {"LOGIN_REQUIRED", "NEEDS_RELOGIN", "TAKEOVER_READY", "LOGIN_READY", "FULL_READY"}
    logged_in_states = {"LOGGED_IN", "SESSION_REUSE_PENDING", "FULL_READY"}
    ready = sum(1 for p in platforms.values() if p.get("status") in login_ready_states)
    logged = sum(1 for p in platforms.values() if p.get("status") in logged_in_states)
    remaining = sum(1 for p in platforms.values() if p.get("status") not in {"FULL_READY"})

    last_run_at = latest_timestamp(
        hard.get("last_run_at"),
        auth.get("updated_at"),
        bridge.get("last_reconciled_at"),
        runtime.get("checked_at"),
    )

    metrics = {
        "schema": "promo.l2.outcome_metrics.v2",
        "mode": "HARD_ONLY",
        "platforms_login_ready": ready,
        "platforms_logged_in": logged,
        "l2_sources_scanned": int(hard.get("l2_sources_scanned") or 0),
        "l2_voucher_deals_found": int(hard.get("l2_voucher_deals_found") or 0),
        "l2_literal_codes_found": int(hard.get("l2_literal_codes_found") or 0),
        "remaining_platforms": remaining,
        "last_run_at": last_run_at,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "public_overlap_excluded": True,
        "note": "L2 metrics count hard/authenticated/access-constrained outcomes only. Routine public crawling is owned by Layer1 and is excluded from L2 totals."
    }
    (ROOT / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(metrics, ensure_ascii=False))


if __name__ == "__main__":
    main()
