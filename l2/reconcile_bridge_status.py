#!/usr/bin/env python3
"""Reconcile non-secret L2 bridge/auth status from sanitized runtime evidence.

Transient or later probe failures never erase previously verified Browser Run
capability. READY is set only after fresh-connection authenticated session reuse.
TAKEOVER_READY is temporary and means a real secure human handoff is active.
"""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / "bridge-runtime-status.json"
BRIDGE = ROOT / "bridge-status.json"
AUTH = ROOT / "auth-status.json"


def read(path: Path, default: dict) -> dict:
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def write(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def main() -> None:
    runtime = read(RUNTIME, {})
    bridge = read(BRIDGE, {})
    auth = read(AUTH, {})

    prior_runtime_verified = bool(bridge.get("runtime_verified"))
    prior_e2e = bool(bridge.get("end_to_end_verified"))
    created = bool(runtime.get("browser_session_created"))
    handoff = bool(runtime.get("human_handoff_exercised"))
    reuse = bool(runtime.get("authenticated_session_reuse_verified"))
    transient = bool(runtime.get("transient_failure"))
    runtime_state = str(runtime.get("state") or "UNKNOWN")

    runtime_verified = prior_runtime_verified or created or runtime_state in {"BROWSER_RUN_PROBE_VERIFIED", "TAKEOVER_READY", "SESSION_REUSE_VERIFIED"}
    e2e = prior_e2e or reuse
    if e2e:
        status = "SESSION_REUSE_VERIFIED"
    elif runtime_state == "TAKEOVER_READY" and runtime_verified:
        status = "TAKEOVER_READY"
    elif runtime_verified:
        status = "BROWSER_RUN_PROBE_VERIFIED_HANDOFF_PENDING"
    elif transient:
        status = str(bridge.get("status") or "TRANSIENT_RATE_LIMIT")
    else:
        status = "BROWSER_RUN_PROBE_UNVERIFIED"

    bridge.update(
        {
            "schema": "promo.l2.bridge_status.v3",
            "project_id": "PROMO-L2-ROUTER-V1",
            "provider": "CLOUDFLARE_BROWSER_RUN_HUMAN_IN_LOOP",
            "status": status,
            "ready": bool(e2e),
            "runtime_verified": bool(runtime_verified),
            "end_to_end_verified": bool(e2e),
            "last_reconciled_at": now_iso(),
            "runtime_verification": {
                "github_actions_secret_presence_verified_without_readback": True,
                "browser_run_session_creation_verified": bool(runtime_verified),
                "cdp_control_verified": bool(runtime_verified),
                "live_view_handoff_exercised": bool(handoff or runtime_state == "TAKEOVER_READY" or prior_e2e),
                "authenticated_session_reuse_verified": bool(e2e),
                "fresh_connection_reuse_required": True,
                "last_runtime_state": runtime_state,
                "transient_failure": transient,
                "status_source": "l2/bridge-runtime-status.json",
            },
        }
    )
    bridge.setdefault("security_invariants", {})
    bridge["security_invariants"].update(
        {
            "passwords_in_github": False,
            "otp_in_github": False,
            "cookies_in_github": False,
            "refresh_tokens_in_github": False,
            "captcha_data_in_github": False,
            "session_ids_in_github": False,
            "websocket_urls_in_github": False,
            "takeover_urls_in_github": False,
            "takeover_urls_in_logs": False,
            "one_platform_failure_pauses_others": False,
        }
    )

    preauth = auth.setdefault("preauth", {})
    preauth["bridge_status"] = status
    preauth["runtime_probe_verified"] = bool(runtime_verified)
    preauth["end_to_end_verified"] = bool(e2e)
    auth["updated_at"] = now_iso()

    platform = str(runtime.get("platform") or "")
    platforms = auth.get("platforms") if isinstance(auth.get("platforms"), dict) else {}

    # Never advertise HANDOFF_READY unless a real secure takeover surface is
    # actually active. Static config/runtime capability only means PREAUTH pending.
    for key, entry in platforms.items():
        if not isinstance(entry, dict):
            continue
        if entry.get("status") in {"HANDOFF_READY", "HANDOFF_READY_OR_RESIDENTIAL_FALLBACK"}:
            entry["status"] = "PREAUTH_PENDING_SESSION"

    if platform in platforms and runtime.get("mode") == "handoff":
        if reuse:
            platforms[platform]["status"] = "SESSION_REUSE_VERIFIED"
        elif runtime_state == "TAKEOVER_READY":
            # Only now does a real secure Live Session exist, so the Telegram
            # monitor may alert for this one platform.
            platforms[platform]["status"] = "LOGIN_REQUIRED"
        elif runtime_state in {"TRANSIENT_RATE_LIMIT", "DAILY_QUOTA_WAIT", "HANDOFF_FAILED", "HANDOFF_REUSE_UNVERIFIED", "HANDOFF_WINDOW_EXPIRED"}:
            # A previously verified takeover that closed before operator completion
            # is recoverable and must stay in the retry lane, not wedge the platform.
            platforms[platform]["status"] = "PREAUTH_RETRY_PENDING"

    write(BRIDGE, bridge)
    write(AUTH, auth)
    print(f"BRIDGE_STATUS_RECONCILED status={status} runtime_verified={str(runtime_verified).lower()} e2e={str(e2e).lower()}")


if __name__ == "__main__":
    main()
