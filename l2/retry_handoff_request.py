#!/usr/bin/env python3
"""Re-arm a sanitized L2 handoff request after a bounded cooldown.

This never opens a browser itself. It only changes a retryable non-secret request
back to REQUESTED when cooldown has elapsed; the request-driven Browser Run
workflow then owns the secure runtime. No secret or session material is read or
written.
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
GENERIC_RATE_LIMIT_ATTEMPTS_BEFORE_DAILY_BACKOFF = 2
RETRYABLE_REQUEST_STATES = {"RETRY_PENDING", "FAILED"}


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


def next_utc_reset(now: dt.datetime) -> str:
    next_day = now.date() + dt.timedelta(days=1)
    return f"{next_day.isoformat()}T00:05:00Z"


def runtime_belongs_to_request(runtime: dict, req: dict) -> bool:
    """Only let a handoff attempt influence that same platform's retry policy.

    Probe runs and another platform's failures are intentionally ignored here.
    This prevents a harmless status-file push/probe from consuming the active
    platform's retry budget or extending its cooldown.
    """
    return (
        runtime.get("mode") == "handoff"
        and str(runtime.get("platform") or "") == str(req.get("platform") or "")
    )


def main() -> None:
    req = load(REQUEST, {})
    runtime = load(RUNTIME, {})
    bridge = load(BRIDGE, {})
    if req.get("state") not in RETRYABLE_REQUEST_STATES or bridge.get("ready") is True:
        print("L2_HANDOFF_RETRY_NOOP")
        return

    runtime_matches = runtime_belongs_to_request(runtime, req)

    # A failed handoff after a previously verified takeover surface is retryable:
    # Cloudflare Browser Run sessions have a bounded lifetime, so operator absence
    # during a window must not permanently wedge the bridge. A generic probe must
    # never be allowed to satisfy this platform-specific condition.
    if req.get("state") == "FAILED" and not (
        runtime_matches
        and runtime.get("browser_session_created") is True
        and runtime.get("human_handoff_exercised") is True
        and bridge.get("runtime_verified") is True
    ):
        print("L2_HANDOFF_RETRY_NOT_VERIFIED")
        return

    now = dt.datetime.now(dt.timezone.utc)
    day = now.date().isoformat()
    attempt_day = str(req.get("attempt_day_utc") or "")
    attempts = int(req.get("attempts_today") or 0) if attempt_day == day else 0

    # A repeated generic 429 from the *same handoff/platform* is commonly a
    # quota-style condition rather than a useful short acquisition retry.
    # Crucially, probe-mode 429s and failures from other platforms do not enter
    # this branch and therefore cannot push this request into a daily backoff.
    if (
        runtime_matches
        and runtime.get("state") == "TRANSIENT_RATE_LIMIT"
        and runtime.get("browser_session_created") is True
        and attempts >= GENERIC_RATE_LIMIT_ATTEMPTS_BEFORE_DAILY_BACKOFF
    ):
        req["state"] = "RETRY_PENDING"
        req["retry_after_utc"] = next_utc_reset(now)
        req["attempt_day_utc"] = day
        req["attempts_today"] = attempts
        REQUEST.write_text(json.dumps(req, indent=2) + "\n")
        print("L2_HANDOFF_RETRY_RATE_LIMIT_DAILY_BACKOFF")
        return

    retry_at = parse_iso(req.get("retry_after_utc"))
    if retry_at is None:
        # Only a matching handoff runtime may seed a cooldown timestamp. If the
        # latest runtime record is an unrelated probe, use now as the safe base.
        checked = parse_iso(runtime.get("checked_at")) if runtime_matches else None
        retry_at = (checked or now) + DEFAULT_COOLDOWN
    if now < retry_at:
        print("L2_HANDOFF_RETRY_COOLDOWN")
        return

    if attempts >= MAX_ATTEMPTS_PER_UTC_DAY:
        req["state"] = "RETRY_PENDING"
        req["retry_after_utc"] = next_utc_reset(now)
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
