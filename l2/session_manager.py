#!/usr/bin/env python3
"""PROMO L2 secure session manager.

Creates Cloudflare Browser Run sessions for authorized accounts and writes the
human takeover URL only to a runtime-local private file. No credentials,
cookies, session IDs, websocket URLs, or takeover URLs are committed or logged.

Expected runtime environment:
  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_BROWSER_RUN_API_TOKEN  (Browser Rendering - Edit)
  L2_PRIVATE_HANDOFF_PATH           (absolute/local path, not under repo)

This manager intentionally does not automate login, OTP, CAPTCHA, or account
registration. A human completes those steps through Live View.
"""
from __future__ import annotations

import json
import os
import stat
import sys
import urllib.parse
import urllib.request
from pathlib import Path

API_ROOT = "https://api.cloudflare.com/client/v4/accounts/{account}/browser-rendering/devtools/browser"
DEFAULT_KEEP_ALIVE_MS = 600_000


def fail(message: str, code: int = 2) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        fail(f"missing required runtime setting: {name}")
    return value


def request_json(url: str, token: str, method: str = "GET"):
    req = urllib.request.Request(
        url,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def write_private_handoff(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Refuse repo-relative destinations; takeover material must stay outside Git.
    repo = Path(__file__).resolve().parents[1]
    resolved_parent = path.resolve().parent
    try:
        resolved_parent.relative_to(repo)
        fail("L2_PRIVATE_HANDOFF_PATH must be outside the repository")
    except ValueError:
        pass
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
    tmp.replace(path)


def create_cloudflare_handoff(platform: str, start_url: str) -> None:
    account = required_env("CLOUDFLARE_ACCOUNT_ID")
    token = required_env("CLOUDFLARE_BROWSER_RUN_API_TOKEN")
    handoff_path = Path(required_env("L2_PRIVATE_HANDOFF_PATH"))
    keep_alive = int(os.environ.get("L2_BROWSER_KEEP_ALIVE_MS", DEFAULT_KEEP_ALIVE_MS))

    base = API_ROOT.format(account=urllib.parse.quote(account, safe=""))
    session = request_json(f"{base}?keep_alive={keep_alive}", token, "POST")
    session_id = session.get("sessionId")
    if not session_id:
        fail("Browser Run did not return a sessionId")

    tab_url = (
        f"{base}/{urllib.parse.quote(session_id, safe='')}/json/new?"
        + urllib.parse.urlencode({"url": start_url})
    )
    tab = request_json(tab_url, token, "PUT")
    live_url = tab.get("devtoolsFrontendUrl")
    if not live_url:
        # Best-effort cleanup without leaking session material.
        try:
            request_json(f"{base}/{urllib.parse.quote(session_id, safe='')}", token, "DELETE")
        finally:
            fail("Browser Run did not return a Live View URL")

    write_private_handoff(
        handoff_path,
        {
            "platform": platform,
            "start_url": start_url,
            "takeover_url": live_url,
            "runtime": "cloudflare-browser-run",
            "instructions": "Complete login/MFA/CAPTCHA manually in Live View, then return control to the runtime.",
        },
    )
    # Deliberately log only a non-secret state marker.
    print(f"TAKEOVER_READY platform={platform} private_handoff_written=true")


def main() -> None:
    if len(sys.argv) != 3:
        fail("usage: session_manager.py <platform> <start_url>")
    platform, start_url = sys.argv[1], sys.argv[2]
    if not start_url.startswith(("https://", "http://")):
        fail("start_url must be http(s)")
    create_cloudflare_handoff(platform, start_url)


if __name__ == "__main__":
    main()
