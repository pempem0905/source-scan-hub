#!/usr/bin/env python3
"""Build sanitized cumulative L2 outcome metrics from non-secret repo state."""
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


def main() -> None:
    public = load_json("public-state.json", {})
    auth = load_json("auth-status.json", {})
    history = public.get("history") or []
    platforms = auth.get("platforms") or {}

    login_ready_states = {"LOGIN_REQUIRED", "NEEDS_RELOGIN", "TAKEOVER_READY", "LOGIN_READY", "FULL_READY"}
    logged_in_states = {"LOGGED_IN", "SESSION_REUSE_PENDING", "FULL_READY"}
    ready = sum(1 for p in platforms.values() if p.get("status") in login_ready_states)
    logged = sum(1 for p in platforms.values() if p.get("status") in logged_in_states)
    remaining = sum(1 for p in platforms.values() if p.get("status") not in {"FULL_READY"})

    metrics = {
        "schema": "promo.l2.outcome_metrics.v1",
        "platforms_login_ready": ready,
        "platforms_logged_in": logged,
        "l2_sources_scanned": sum(int(r.get("attempted") or 0) for r in history),
        "l2_voucher_deals_found": sum(int(r.get("promo_candidates") or 0) for r in history),
        "l2_literal_codes_found": sum(int(r.get("code_candidates") or 0) for r in history),
        "remaining_platforms": remaining,
        "last_run_at": public.get("updated_at") or (history[-1].get("at") if history else None),
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "note": "Counts are sanitized cumulative L2 scan outcomes; candidates remain subject to date/technical/Turbo quality gates before production use."
    }
    (ROOT / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(metrics, ensure_ascii=False))


if __name__ == "__main__":
    main()
