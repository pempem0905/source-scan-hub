#!/usr/bin/env python3
"""Re-arm a sanitized L2 handoff request after a bounded cooldown.

This never opens a browser itself. It only changes RETRY_PENDING -> REQUESTED
when the cooldown has elapsed; the request-driven Browser Run workflow then owns
the secure runtime. No secret or session material is read or written.
"""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REQUEST = ROOT / "handoff-request.json"
RUNTIME = ROOT / "bridge-runtime-status.json"
BRIDGE = ROOT / "bridge-status.json"
DEFAULT_COOLDOWN = dt.timedelta(minutes=30)
MAX_ATTEMPTS_PER_UTC_DAY = 8


def load(path: Path, default: dict) -> dict:
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def parse_iso(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(dt.timezone.utc)
    except Exception:
        return None


def main() -> None:
    req = load(REQUEST, {})
    runtime = load(RUNTIME, {})
    bridge = load(BRIDGE, {})
    if req.get("state") != "RETRY_PENDING" or bridge.get("ready") is True:
        print("L2_HANDOFF_RETRY_NOOP")
        return

    now = dt.datetime.now(dt.timezone.utc)
    retry_at = parse_iso(req.get("retry_after_utc"))
    if retry_at is None:
        checked = parse_iso(runtime.get("checked_at")) or now
        retry_at = checked + DEFAULT_COOLDOWN
    if now < retry_at:
        print("L2_HANDOFF_RETRY_COOLDOWN")
        return

    day = now.date().isoformat()
    attempt_day = str(req.get("attempt_day_utc") or "")
    attempts = int(req.get("attempts_today") or 0) if attempt_day == day else 0
    if attempts >= MAX_ATTEMPTS_PER_UTC_DAY:
        next_day = now.date() + dt.timedelta(days=1)
        req["retry_after_utc"] = f"{next_day.isoformat()}T00:05:00Z"
        req["attempt_day_utc"] = day
        req["attempts_today"] = attempts
        REQUEST.write_text(json.dumps(req, indent=2) + "\n")
        print("L2_HANDOFF_RETRY_DAILY_CAP")
        return

    req["state"] = "REQUESTED"
    req["attempt_day_utc"] = day
    req["attempts_today"] = attempts + 1
    req["last_retry_requested_at"] = now.isoformat().replace("+00:00", "Z")
    req.pop("retry_after_utc", None)
    REQUEST.write_text(json.dumps(req, indent=2) + "\n")
    print(f"L2_HANDOFF_RETRY_ARMED attempt={attempts + 1}")


if __name__ == "__main__":
    main()
