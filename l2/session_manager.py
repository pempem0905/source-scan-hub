#!/usr/bin/env python3
"""PROMO L2 secure session-manager entrypoint.

This module intentionally owns no second Browser Run implementation. It resolves
an authorized, platform-isolated profile from preauth-platforms.json and delegates
to browser_run_cdp.py, the canonical bridge that performs structured human
handoff plus fresh-connection session-reuse verification.

Secrets are inherited only by the child runtime process and are never printed,
serialized or written by this wrapper. Session IDs, websocket URLs, cookies,
Live View URLs and takeover material remain runtime-only inside the canonical
bridge.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REGISTRY = ROOT / "preauth-platforms.json"
BRIDGE = ROOT / "browser_run_cdp.py"
PLATFORM_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def fail(message: str, code: int = 2) -> None:
    print(f"SESSION_MANAGER_ERROR {message[:160]}", file=sys.stderr)
    raise SystemExit(code)


def load_registry() -> dict:
    try:
        data = json.loads(REGISTRY.read_text(encoding="utf-8"))
    except Exception:
        fail("authorized platform registry unavailable")
    platforms = data.get("platforms") if isinstance(data, dict) else None
    if not isinstance(platforms, dict):
        fail("authorized platform registry invalid")
    return platforms


def resolve_platform(platform: str) -> tuple[str, str]:
    if not PLATFORM_RE.fullmatch(platform):
        fail("invalid platform key")
    entry = load_registry().get(platform)
    if not isinstance(entry, dict):
        fail("platform is not registered for authorized preauth")
    if entry.get("access_class") != "AUTHORIZED_ACCOUNT":
        fail("platform is not authorized for account handoff")
    profile_id = str(entry.get("profile_id") or "").strip()
    start_url = str(entry.get("start_url") or "").strip()
    if not profile_id:
        fail("platform profile is missing")
    if not start_url.startswith(("https://", "http://")):
        fail("platform start URL is unavailable")
    return profile_id, start_url


def main() -> None:
    if len(sys.argv) not in {2, 3}:
        fail("usage: session_manager.py <platform> [probe|handoff]")
    platform = sys.argv[1]
    mode = sys.argv[2] if len(sys.argv) == 3 else "handoff"
    if mode not in {"probe", "handoff"}:
        fail("mode must be probe or handoff")
    profile_id, start_url = resolve_platform(platform)
    # Non-sensitive readiness marker only. Profile ID is a logical routing key,
    # not a session identifier or credential.
    print(f"SESSION_MANAGER_ROUTE platform={platform} profile={profile_id} mode={mode}")
    completed = subprocess.run(
        [sys.executable, str(BRIDGE), mode, platform, start_url],
        check=False,
    )
    raise SystemExit(completed.returncode)


if __name__ == "__main__":
    main()
