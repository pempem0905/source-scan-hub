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
PREAUTH = ROOT / "preauth-platforms.json"
HANDOFF_REQUEST = ROOT / "handoff-request.json"


def read(path: Path, default: dict) -> dict:
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def write(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def now_iso() -> str:
    return now_utc().isoformat().replace("+00:00", "Z")


def parse_iso(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(dt.timezone.utc)
    except Exception:
        return None


def parse_day(value: str | None) -> dt.date | None:
    if not value:
        return None
    try:
        return dt.date.fromisoformat(str(value))
    except Exception:
        return None


def main() -> None:
    runtime = read(RUNTIME, {})
    bridge = read(BRIDGE, {})
    auth = read(AUTH, {})
    preauth_registry = read(PREAUTH, {})
    request = read(HANDOFF_REQUEST, {})

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

    retry_after_raw = request.get("retry_after_utc")
    retry_after = parse_iso(retry_after_raw)
    attempt_day = parse_day(request.get("attempt_day_utc"))
    # Treat a retry explicitly deferred into a later UTC day as a free-tier daily
    # quota wait for the entire remaining window. The previous >=6h heuristic
    # became false during the final hours before reset and caused status churn.
    quota_wait = bool(
        request.get("state") == "RETRY_PENDING"
        and retry_after is not None
        and retry_after > now_utc()
        and attempt_day is not None
        and retry_after.date() > attempt_day
    )

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
    preauth["free_daily_quota_wait"] = quota_wait
    preauth["next_retry_at"] = retry_after_raw if quota_wait else None

    if status == "TAKEOVER_READY":
        permission = {
            "state": "PERMISSION_REQUIRED",
            "reason": "A real secure Cloudflare Browser Run takeover window is active for one authorized platform.",
            "safe_action": "Open Cloudflare Dashboard > Browser Run > Live Sessions and complete login/MFA/CAPTCHA only inside the active secure session.",
            "note": "Do not place passwords, OTPs, cookies, refresh tokens, CAPTCHA data, session IDs, websocket URLs, or takeover URLs in GitHub files, logs, chat, or public dashboard."
        }
        remaining_gate = {
            "state": "PERMISSION_REQUIRED",
            "reason": "A real secure login surface is active and requires the authorized user to complete login before session reuse can be verified.",
            "safe_action": permission["safe_action"],
        }
    elif quota_wait:
        permission = {
            "state": "WAITING_FREE_DAILY_QUOTA",
            "reason": "The verified free Browser Run lane is waiting for its next daily acquisition window.",
            "safe_action": "No user action is required; the bridge will retry automatically after the recorded UTC retry time.",
            "note": "No login alert is emitted until a real secure takeover surface is active."
        }
        remaining_gate = {
            "state": "WAITING_FREE_DAILY_QUOTA",
            "reason": permission["reason"],
            "safe_action": permission["safe_action"],
        }
    else:
        permission = {
            "state": "WAITING_RUNTIME_WINDOW",
            "reason": "No real secure takeover surface is active right now.",
            "safe_action": "No user action is required until bridge_status becomes TAKEOVER_READY.",
            "note": "The bridge will retry autonomously; sensitive login material remains runtime-only."
        }
        remaining_gate = {
            "state": "WAITING_RUNTIME_WINDOW",
            "reason": permission["reason"],
            "safe_action": permission["safe_action"],
        }

    preauth["permission_required"] = permission
    bridge["remaining_gate"] = remaining_gate
    auth["updated_at"] = now_iso()

    platform = str(runtime.get("platform") or "")
    platforms = auth.get("platforms") if isinstance(auth.get("platforms"), dict) else {}

    for key, entry in platforms.items():
        if not isinstance(entry, dict):
            continue
        if entry.get("status") in {"HANDOFF_READY", "HANDOFF_READY_OR_RESIDENTIAL_FALLBACK"}:
            entry["status"] = "PREAUTH_PENDING_SESSION"

    if platform in platforms and runtime.get("mode") == "handoff":
        if reuse:
            platforms[platform]["status"] = "SESSION_REUSE_VERIFIED"
        elif runtime_state == "TAKEOVER_READY":
            platforms[platform]["status"] = "LOGIN_REQUIRED"
        elif runtime_state in {"TRANSIENT_RATE_LIMIT", "DAILY_QUOTA_WAIT", "HANDOFF_FAILED", "HANDOFF_REUSE_UNVERIFIED", "HANDOFF_WINDOW_EXPIRED"}:
            platforms[platform]["status"] = "PREAUTH_RETRY_PENDING"

    reg_platforms = preauth_registry.get("platforms") if isinstance(preauth_registry.get("platforms"), dict) else {}
    for key, auth_entry in platforms.items():
        if key in reg_platforms and isinstance(auth_entry, dict) and isinstance(reg_platforms[key], dict):
            reg_platforms[key]["status"] = auth_entry.get("status")
    reg_bridge = preauth_registry.setdefault("bridge", {})
    reg_bridge["status"] = status
    reg_bridge["runtime_verified"] = bool(runtime_verified)
    reg_bridge["end_to_end_verified"] = bool(e2e)

    write(BRIDGE, bridge)
    write(AUTH, auth)
    write(PREAUTH, preauth_registry)
    print(f"BRIDGE_STATUS_RECONCILED status={status} runtime_verified={str(runtime_verified).lower()} e2e={str(e2e).lower()} quota_wait={str(quota_wait).lower()}")


if __name__ == "__main__":
    main()
