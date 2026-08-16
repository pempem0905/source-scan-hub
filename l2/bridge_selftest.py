#!/usr/bin/env python3
"""Static/runtime consistency self-test for the PROMO L2 secure login bridge.

No network access and no secrets are required. This validates repository
artifacts, workflow wiring and security/readiness invariants so it can run
frequently without consuming Browser Run quota.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
L2 = ROOT / "l2"
REQUIRED_LOGIN_PLATFORMS = {"grabfood", "shopeefood", "tiktok", "tiktokshop"}


def load(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise AssertionError(f"invalid json: {path.relative_to(ROOT)}") from exc


def assert_no_sensitive_runtime_keys(obj, path="root") -> None:
    forbidden = {
        "session_id", "sessionid", "websocket_url", "websocketurl", "ws_url",
        "takeover_url", "live_view_url", "cookie", "cookies", "password", "otp",
        "refresh_token", "access_token", "captcha_data",
    }
    if isinstance(obj, dict):
        for key, value in obj.items():
            k = str(key).lower()
            assert k not in forbidden, f"sensitive runtime key persisted at {path}.{key}"
            assert_no_sensitive_runtime_keys(value, f"{path}.{key}")
    elif isinstance(obj, list):
        for i, value in enumerate(obj):
            assert_no_sensitive_runtime_keys(value, f"{path}[{i}]")


def main() -> None:
    bridge = load(L2 / "bridge-status.json")
    runtime = load(L2 / "bridge-runtime-status.json")
    auth = load(L2 / "auth-status.json")
    preauth = load(L2 / "preauth-platforms.json")
    request = load(L2 / "handoff-request.json") if (L2 / "handoff-request.json").exists() else {}

    assert bridge.get("provider") == "CLOUDFLARE_BROWSER_RUN_HUMAN_IN_LOOP"
    assert runtime.get("provider") == "CLOUDFLARE_BROWSER_RUN"
    assert runtime.get("secret_values_observable") is False
    assert runtime.get("sensitive_runtime_material_persisted") is False
    assert runtime.get("ready") is not True or runtime.get("authenticated_session_reuse_verified") is True
    assert bridge.get("ready") is not True or bridge.get("end_to_end_verified") is True
    assert bridge.get("end_to_end_verified") is not True or runtime.get("authenticated_session_reuse_verified") is True

    invariants = bridge.get("security_invariants") or {}
    for key in (
        "passwords_in_github", "otp_in_github", "cookies_in_github",
        "refresh_tokens_in_github", "captcha_data_in_github", "session_ids_in_github",
        "websocket_urls_in_github", "takeover_urls_in_github", "takeover_urls_in_logs",
        "one_platform_failure_pauses_others",
    ):
        assert invariants.get(key) is False, f"security invariant not false: {key}"

    platforms = preauth.get("platforms") or {}
    auth_platforms = auth.get("platforms") or {}
    missing = REQUIRED_LOGIN_PLATFORMS - set(platforms)
    assert not missing, f"missing required login platforms in registry: {sorted(missing)}"
    missing_auth = REQUIRED_LOGIN_PLATFORMS - set(auth_platforms)
    assert not missing_auth, f"missing required login platforms in auth status: {sorted(missing_auth)}"

    profile_ids = []
    for name, cfg in platforms.items():
        pid = cfg.get("profile_id")
        assert pid, f"missing profile_id: {name}"
        profile_ids.append(pid)
        if cfg.get("status") != "WAIT_SOURCE_MAPPING":
            assert cfg.get("start_url"), f"missing start_url: {name}"
        if name in auth_platforms:
            assert auth_platforms[name].get("profile_id") == pid, f"profile mismatch: {name}"
    assert len(profile_ids) == len(set(profile_ids)), "platform profile IDs must be isolated and unique"

    bridge_state = bridge.get("status")
    login_required = [
        name for name, cfg in auth_platforms.items()
        if isinstance(cfg, dict) and cfg.get("status") == "LOGIN_REQUIRED"
    ]
    if login_required:
        assert bridge_state == "TAKEOVER_READY", "LOGIN_REQUIRED allowed only while a real takeover is active"
        assert len(login_required) == 1, "only the affected platform may be LOGIN_REQUIRED"
    if bridge_state == "TAKEOVER_READY":
        assert runtime.get("state") == "TAKEOVER_READY"
        assert runtime.get("human_handoff_exercised") is True
        assert login_required, "active takeover must identify one affected platform"

    if request:
        assert request.get("state") in {"REQUESTED", "ACTIVE", "DONE", "FAILED", "RETRY_PENDING"}
        assert request.get("platform") in platforms

    assert_no_sensitive_runtime_keys(runtime, "bridge-runtime-status")

    login_html = (ROOT / "docs" / "login-center.html").read_text(encoding="utf-8")
    assert "Cloudflare Dashboard" in login_html and "Live Sessions" in login_html
    assert "password" in login_html and "OTP" in login_html

    bridge_py = (L2 / "browser_run_cdp.py").read_text(encoding="utf-8")
    for marker in ("acquire_browser_ws", "wait_event_with_heartbeat", "BACKOFF_MARKER", "HANDOFF_COMPLETE_SESSION_REUSE_VERIFIED"):
        assert marker in bridge_py, f"bridge regression: missing {marker}"

    request_workflow = (ROOT / ".github" / "workflows" / "promo-l2-browser-run-bridge.yml").read_text(encoding="utf-8")
    assert "l2/handoff-request.json" in request_workflow, "request-driven bridge trigger missing"
    assert "CLOUDFLARE_BROWSER_RUN_API_TOKEN" in request_workflow and "CLOUDFLARE_ACCOUNT_ID" in request_workflow
    assert "secrets.CLOUDFLARE_BROWSER_RUN_API_TOKEN" in request_workflow
    assert "secrets.CLOUDFLARE_ACCOUNT_ID" in request_workflow

    manual_workflow = (ROOT / ".github" / "workflows" / "promo-l2-secure-login-bridge.yml").read_text(encoding="utf-8")
    assert "tiktokshop" in manual_workflow, "manual bridge must expose TikTok Shop"
    on_header = manual_workflow.split("permissions:", 1)[0]
    assert "push:" not in on_header, "manual secure bridge must not auto-probe on push"

    print(
        "L2_BRIDGE_SELFTEST_OK "
        f"bridge={bridge_state} runtime={runtime.get('state')} "
        f"profiles={len(profile_ids)} request={request.get('state','NONE')}"
    )


if __name__ == "__main__":
    main()
