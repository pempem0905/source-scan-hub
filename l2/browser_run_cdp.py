#!/usr/bin/env python3
"""Secure Cloudflare Browser Run CDP bridge for PROMO L2.

This runtime intentionally keeps all sensitive Browser Run material in memory:
API tokens, browser/session IDs, target IDs, websocket URLs, Live View URLs,
cookies/storage and handoff identifiers are never printed or persisted.

Modes:
  probe   - create a real Browser Run CDP session and verify browser control.
  handoff - navigate to an authorized platform, request structured human handoff,
            then disconnect, rediscover the live session via Cloudflare API,
            reconnect as a fresh L2 consumer and verify authenticated state reuse.

The human takeover surface is Cloudflare Dashboard > Browser Run > Live Sessions;
the ephemeral Live View URL is generated to prove capability but is not exposed.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import ssl
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

import websockets

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
API_TOKEN = os.environ.get("CLOUDFLARE_BROWSER_RUN_API_TOKEN", "").strip()
KEEP_ALIVE_MS = max(10_000, min(600_000, int(os.environ.get("L2_BROWSER_KEEP_ALIVE_MS", "600000"))))
HANDOFF_TIMEOUT_MS = max(60_000, min(1_800_000, int(os.environ.get("L2_HANDOFF_TIMEOUT_MS", "1800000"))))
API_HTTP = f"https://api.cloudflare.com/client/v4/accounts/{urllib.parse.quote(ACCOUNT_ID, safe='')}/browser-rendering/devtools"
LAUNCH_WS = f"wss://api.cloudflare.com/client/v4/accounts/{urllib.parse.quote(ACCOUNT_ID, safe='')}/browser-run/devtools/browser?keep_alive={KEEP_ALIVE_MS}"
LOGIN_RE = re.compile(r"/(?:login|signin|sign-in|auth)(?:[/?#]|$)", re.I)


def safe_platform(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", value)[:64] or "unknown"


def fail(message: str, code: int = 2) -> None:
    # Keep errors generic. Never include exception repr/URLs/session material.
    print(f"BRIDGE_ERROR {message[:180]}", file=sys.stderr)
    raise SystemExit(code)


def http_json(url: str) -> Any:
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {API_TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30, context=ssl.create_default_context()) as resp:
        return json.loads(resp.read().decode("utf-8"))


@dataclass
class CDP:
    ws: Any
    seq: int = 0

    async def call(self, method: str, params: dict | None = None, session_id: str | None = None) -> dict:
        self.seq += 1
        request_id = self.seq
        payload: dict[str, Any] = {"id": request_id, "method": method, "params": params or {}}
        if session_id:
            payload["sessionId"] = session_id
        await self.ws.send(json.dumps(payload, separators=(",", ":")))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") != request_id:
                # Events are intentionally ignored here; handoff uses wait_event.
                continue
            if "error" in msg:
                raise RuntimeError(f"CDP command failed: {method}")
            return msg.get("result") or {}

    async def wait_event(self, method: str, session_id: str | None = None, timeout_ms: int = 60_000) -> dict:
        async def _wait() -> dict:
            while True:
                msg = json.loads(await self.ws.recv())
                if msg.get("method") == method and (session_id is None or msg.get("sessionId") == session_id):
                    return msg.get("params") or {}
        return await asyncio.wait_for(_wait(), timeout=timeout_ms / 1000)


async def open_socket(endpoint: str):
    return await websockets.connect(
        endpoint,
        additional_headers={"Authorization": f"Bearer {API_TOKEN}"},
        open_timeout=45,
        close_timeout=10,
        max_size=8 * 1024 * 1024,
    )


async def attach_page(cdp: CDP, start_url: str | None = None) -> tuple[str, str]:
    targets = (await cdp.call("Target.getTargets")).get("targetInfos", [])
    page = next((t for t in targets if t.get("type") == "page"), None)
    if page is None:
        created = await cdp.call("Target.createTarget", {"url": start_url or "about:blank"})
        target_id = created.get("targetId")
    else:
        target_id = page.get("targetId")
    if not target_id:
        raise RuntimeError("no page target")
    attached = await cdp.call("Target.attachToTarget", {"targetId": target_id, "flatten": True})
    session_id = attached.get("sessionId")
    if not session_id:
        raise RuntimeError("cannot attach page target")
    await cdp.call("Page.enable", session_id=session_id)
    await cdp.call("Runtime.enable", session_id=session_id)
    await cdp.call("Network.enable", session_id=session_id)
    if start_url:
        await cdp.call("Page.navigate", {"url": start_url}, session_id=session_id)
        await asyncio.sleep(2.0)
    return target_id, session_id


async def current_url(cdp: CDP, session_id: str) -> str:
    result = await cdp.call(
        "Runtime.evaluate",
        {"expression": "location.href", "returnByValue": True},
        session_id=session_id,
    )
    return str(((result.get("result") or {}).get("value")) or "")


async def cookie_count(cdp: CDP, session_id: str) -> int:
    result = await cdp.call("Network.getCookies", session_id=session_id)
    return len(result.get("cookies") or [])


def host_of(url: str) -> str:
    try:
        return (urllib.parse.urlsplit(url).hostname or "").lower()
    except Exception:
        return ""


def discover_live_session_for_host(host: str) -> str | None:
    sessions = http_json(f"{API_HTTP}/session")
    if isinstance(sessions, dict) and "result" in sessions:
        sessions = sessions.get("result")
    if not isinstance(sessions, list):
        return None
    # Newest first where timestamps are available.
    sessions = sorted(sessions, key=lambda x: x.get("lastUpdated") or x.get("startTime") or 0, reverse=True)
    for item in sessions:
        sid = item.get("sessionId")
        if not sid:
            continue
        try:
            targets = http_json(f"{API_HTTP}/browser/{urllib.parse.quote(str(sid), safe='')}/json/list")
            if isinstance(targets, dict) and "result" in targets:
                targets = targets.get("result")
            if not isinstance(targets, list):
                continue
            if not any(host_of(str(t.get("url") or "")) == host for t in targets):
                continue
            ws = item.get("webSocketDebuggerUrl")
            if ws:
                return str(ws)
            return f"wss://api.cloudflare.com/client/v4/accounts/{urllib.parse.quote(ACCOUNT_ID, safe='')}/browser-rendering/devtools/browser/{urllib.parse.quote(str(sid), safe='')}"
        except Exception:
            continue
    return None


async def probe(platform: str, start_url: str) -> None:
    ws = await open_socket(LAUNCH_WS)
    try:
        cdp = CDP(ws)
        version = await cdp.call("Browser.getVersion")
        if not version.get("product"):
            raise RuntimeError("browser target unavailable")
        _, page_session = await attach_page(cdp, start_url)
        if not (await current_url(cdp, page_session)).startswith(("http://", "https://")):
            raise RuntimeError("navigation verification failed")
        print(f"BROWSER_SESSION_CREATE_VERIFIED platform={safe_platform(platform)} cdp_control=true")
        # Probe does not need persistence; close the browser process explicitly.
        try:
            await cdp.call("Browser.close")
        except Exception:
            pass
    finally:
        await ws.close()


async def handoff(platform: str, start_url: str) -> None:
    expected_host = host_of(start_url)
    if not expected_host:
        raise RuntimeError("invalid start host")

    ws = await open_socket(LAUNCH_WS)
    cdp = CDP(ws)
    _, page_session = await attach_page(cdp, start_url)

    # Generate Live View to prove human takeover capability but never expose URL.
    live = await cdp.call(
        "Cloudflare.getLiveView",
        {"mode": "tab", "expiresInMs": 300_000},
        session_id=page_session,
    )
    if not live.get("devtoolsFrontendUrl"):
        await ws.close()
        raise RuntimeError("live view unavailable")

    print(f"HUMAN_TAKEOVER_REQUIRED platform={safe_platform(platform)} surface=cloudflare_dashboard_live_sessions")
    await cdp.call(
        "Cloudflare.handoff",
        {
            "instructions": f"Complete the authorized {safe_platform(platform)} sign-in, MFA or CAPTCHA manually, then mark the handoff complete.",
            "timeout": HANDOFF_TIMEOUT_MS,
        },
        session_id=page_session,
    )
    result = await cdp.wait_event(
        "Cloudflare.handoffComplete",
        session_id=page_session,
        timeout_ms=HANDOFF_TIMEOUT_MS + 15_000,
    )
    if not result.get("success"):
        await ws.close()
        raise RuntimeError("handoff not completed")

    before_url = await current_url(cdp, page_session)
    before_count = await cookie_count(cdp, page_session)
    await cdp.call("Page.reload", {"ignoreCache": False}, session_id=page_session)
    await asyncio.sleep(2.0)
    after_url = await current_url(cdp, page_session)
    after_count = await cookie_count(cdp, page_session)
    first_pass = (
        after_url.startswith(("http://", "https://"))
        and before_count > 0
        and after_count > 0
        and (not LOGIN_RE.search(after_url) or not LOGIN_RE.search(before_url))
    )
    if not first_pass:
        await ws.close()
        print(f"HANDOFF_COMPLETE_REUSE_UNVERIFIED platform={safe_platform(platform)}")
        raise SystemExit(3)

    # Disconnect without Browser.close, then rediscover the live session using only
    # Cloudflare's private API. This proves L2 can reuse the authenticated browser
    # from a fresh control connection without persisting a session identifier.
    await ws.close()
    await asyncio.sleep(1.0)
    reconnect_endpoint = discover_live_session_for_host(expected_host)
    if not reconnect_endpoint:
        print(f"HANDOFF_COMPLETE_REUSE_UNVERIFIED platform={safe_platform(platform)}")
        raise SystemExit(3)

    ws2 = await open_socket(reconnect_endpoint)
    try:
        cdp2 = CDP(ws2)
        _, page_session2 = await attach_page(cdp2)
        url2 = await current_url(cdp2, page_session2)
        cookies2 = await cookie_count(cdp2, page_session2)
        if cookies2 <= 0 or LOGIN_RE.search(url2):
            print(f"HANDOFF_COMPLETE_REUSE_UNVERIFIED platform={safe_platform(platform)}")
            raise SystemExit(3)
        print(f"HANDOFF_COMPLETE_SESSION_REUSE_VERIFIED platform={safe_platform(platform)} reconnect=true")
    finally:
        await ws2.close()


async def main() -> None:
    if not ACCOUNT_ID or not API_TOKEN:
        fail("required Cloudflare runtime settings unavailable")
    if len(sys.argv) != 4:
        fail("usage: browser_run_cdp.py <probe|handoff> <platform> <start_url>")
    mode, platform, start_url = sys.argv[1:4]
    if mode not in {"probe", "handoff"}:
        fail("invalid mode")
    if not start_url.startswith(("https://", "http://")):
        fail("start URL must be http(s)")
    try:
        if mode == "probe":
            await probe(platform, start_url)
        else:
            await handoff(platform, start_url)
    except SystemExit:
        raise
    except Exception:
        fail("Cloudflare Browser Run operation failed")


if __name__ == "__main__":
    asyncio.run(main())
