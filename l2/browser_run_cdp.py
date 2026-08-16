#!/usr/bin/env python3
"""Secure Cloudflare Browser Run CDP bridge for PROMO L2.

Sensitive Browser Run material stays in memory only: API tokens, browser/session
IDs, websocket URLs, Live View URLs, cookies/storage and handoff identifiers are
never printed or persisted.

Modes:
  probe   - create a real Browser Run CDP session and verify browser control.
  handoff - navigate to an authorized platform, request structured human handoff,
            disconnect without closing the remote browser, rediscover the live
            session through Cloudflare's private API, reconnect from a fresh CDP
            connection, and verify authenticated state reuse.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import ssl
import sys
import urllib.error
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
    print(f"BRIDGE_ERROR {message[:180]}", file=sys.stderr)
    raise SystemExit(code)


def exception_status(exc: BaseException) -> int | None:
    if isinstance(exc, urllib.error.HTTPError):
        return int(exc.code)
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None) or getattr(response, "status", None)
    try:
        return int(status) if status is not None else None
    except Exception:
        return None


def transient_rate_limit(exc: BaseException) -> bool:
    status = exception_status(exc)
    if status == 429:
        return True
    text = str(exc).lower()
    return "429" in text or "rate limit" in text or "too many requests" in text


def safe_diagnostic(exc: BaseException) -> str:
    # Intentionally expose only exception class and numeric HTTP status. Never
    # include exception text because websocket/HTTP errors can contain URLs.
    status = exception_status(exc)
    suffix = f" http_status={status}" if status is not None else ""
    return f"type={type(exc).__name__}{suffix}"


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


def host_of(url: str) -> str:
    try:
        return (urllib.parse.urlsplit(url).hostname or "").lower()
    except Exception:
        return ""


def same_host_or_subdomain(candidate: str, expected: str) -> bool:
    return candidate == expected or candidate.endswith("." + expected) or expected.endswith("." + candidate)


async def attach_page(cdp: CDP, start_url: str | None = None, desired_host: str | None = None) -> tuple[str, str]:
    targets = (await cdp.call("Target.getTargets")).get("targetInfos", [])
    pages = [t for t in targets if t.get("type") == "page"]
    page = None
    if desired_host:
        page = next((t for t in pages if same_host_or_subdomain(host_of(str(t.get("url") or "")), desired_host)), None)
    page = page or next((t for t in pages if str(t.get("url") or "") != "about:blank"), None) or (pages[0] if pages else None)
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


def discover_live_session_for_host(host: str) -> str | None:
    sessions = http_json(f"{API_HTTP}/session")
    if isinstance(sessions, dict) and "result" in sessions:
        sessions = sessions.get("result")
    if not isinstance(sessions, list):
        return None
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
            if not any(same_host_or_subdomain(host_of(str(t.get("url") or "")), host) for t in targets):
                continue
            ws = item.get("webSocketDebuggerUrl")
            if ws:
                return str(ws)
            return f"wss://api.cloudflare.com/client/v4/accounts/{urllib.parse.quote(ACCOUNT_ID, safe='')}/browser-rendering/devtools/browser/{urllib.parse.quote(str(sid), safe='')}"
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                raise
            continue
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

    before_count = await cookie_count(cdp, page_session)
    await cdp.call("Page.reload", {"ignoreCache": False}, session_id=page_session)
    await asyncio.sleep(2.0)
    after_url = await current_url(cdp, page_session)
    after_count = await cookie_count(cdp, page_session)
    first_pass = (
        after_url.startswith(("http://", "https://"))
        and before_count > 0
        and after_count > 0
        and not LOGIN_RE.search(after_url)
    )
    if not first_pass:
        await ws.close()
        print(f"HANDOFF_COMPLETE_REUSE_UNVERIFIED platform={safe_platform(platform)}")
        raise SystemExit(3)

    await ws.close()
    await asyncio.sleep(1.5)
    reconnect_endpoint = discover_live_session_for_host(expected_host)
    if not reconnect_endpoint:
        print(f"HANDOFF_COMPLETE_REUSE_UNVERIFIED platform={safe_platform(platform)}")
        raise SystemExit(3)

    ws2 = await open_socket(reconnect_endpoint)
    try:
        cdp2 = CDP(ws2)
        _, page_session2 = await attach_page(cdp2, desired_host=expected_host)
        url2 = await current_url(cdp2, page_session2)
        cookies2 = await cookie_count(cdp2, page_session2)
        if cookies2 <= 0 or LOGIN_RE.search(url2) or not same_host_or_subdomain(host_of(url2), expected_host):
            print(f"HANDOFF_COMPLETE_REUSE_UNVERIFIED platform={safe_platform(platform)}")
            raise SystemExit(3)
        print(f"HANDOFF_COMPLETE_SESSION_REUSE_VERIFIED platform={safe_platform(platform)} reconnect=fresh")
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
    except Exception as exc:
        if transient_rate_limit(exc):
            print("BRIDGE_TRANSIENT_RATE_LIMIT", file=sys.stderr)
            raise SystemExit(75)
        print(f"BRIDGE_DIAGNOSTIC {safe_diagnostic(exc)}", file=sys.stderr)
        fail("Cloudflare Browser Run operation failed")


if __name__ == "__main__":
    asyncio.run(main())
