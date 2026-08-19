#!/usr/bin/env python3
"""Send outcome-only L2 milestone alerts without exposing sensitive runtime material."""
from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATUS_PATH = ROOT / "integration/l2_milestone_alert_status.json"
AUTH_PATH = ROOT / "l2/auth-status.json"
RUNTIME_PATH = ROOT / "l2/bridge-runtime-status.json"
METRICS_PATH = ROOT / "l2/metrics.json"


def load(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def parse_dt(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return None


def send_telegram(text: str) -> dict:
    token = (os.getenv("TELEGRAM_BOT_TOKEN") or "").strip()
    chat_id = (os.getenv("TELEGRAM_CHAT_ID") or "").strip()
    if not token or not chat_id:
        return {"state": "CREDENTIALS_MISSING", "sent": False}
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = urllib.parse.urlencode(
        {"chat_id": chat_id, "text": text, "disable_web_page_preview": "true"}
    ).encode()
    try:
        req = urllib.request.Request(
            url,
            data=data,
            method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        with urllib.request.urlopen(req, timeout=20) as response:
            payload = json.loads(response.read().decode())
        return {"state": "SENT" if payload.get("ok") else "API_ERROR", "sent": bool(payload.get("ok"))}
    except Exception as exc:
        return {"state": "SEND_ERROR", "sent": False, "error": f"{type(exc).__name__}:{exc}"[:240]}


def main() -> None:
    auth = load(AUTH_PATH, {})
    runtime = load(RUNTIME_PATH, {})
    metrics = load(METRICS_PATH, {})
    prior = load(STATUS_PATH, {})
    now = datetime.now(timezone.utc)

    platforms = auth.get("platforms") or {}
    platform = str(runtime.get("platform") or "")
    pstatus = str((platforms.get(platform) or {}).get("status") or "")
    checked = parse_dt(runtime.get("checked_at"))
    age_s = (now - checked).total_seconds() if checked else 10**9

    # LOGIN_READY means a real, currently-active human takeover surface only.
    login_surface_active = (
        runtime.get("state") == "TAKEOVER_READY"
        and runtime.get("browser_session_created") is True
        and runtime.get("human_handoff_exercised") is True
        and runtime.get("ready") is False
        and 0 <= age_s <= 570
        and pstatus in {"LOGIN_REQUIRED", "NEEDS_RELOGIN", "TAKEOVER_READY", "LOGIN_READY"}
    )

    current_metrics = {
        "l2_sources_scanned": int(metrics.get("l2_sources_scanned") or 0),
        "l2_voucher_deals_found": int(metrics.get("l2_voucher_deals_found") or 0),
        "l2_literal_codes_found": int(metrics.get("l2_literal_codes_found") or 0),
    }
    prior_metrics = prior.get("last_metrics") or current_metrics
    meaningful_result = any(current_metrics[k] > int(prior_metrics.get(k) or 0) for k in current_metrics)

    alert_kind = None
    text = None
    alert_key = None
    if login_surface_active:
        alert_key = f"login|{platform}|{runtime.get('checked_at')}"
        if alert_key != prior.get("last_alert_key"):
            alert_kind = "LOGIN_READY"
            logged = sum(1 for p in platforms.values() if str((p or {}).get("status") or "") in {"AUTHENTICATED", "LOGGED_IN", "SESSION_REUSE_VERIFIED", "FULL_READY"})
            total = len(platforms)
            text = "\n".join([
                f"L2: có thể login {platform} ngay | đã login {logged}/{total} nền tảng",
                f"Kết quả L2: {current_metrics['l2_sources_scanned']} source | +{current_metrics['l2_voucher_deals_found']} voucher/deal | +{current_metrics['l2_literal_codes_found']} code",
                "Còn lại: mở https://dash.cloudflare.com/ > Browser Run > Live Sessions và đăng nhập trong session đang active",
                "ETA login: cửa sổ login đang mở ngay lúc này",
            ])
    elif meaningful_result:
        alert_key = f"result|{current_metrics['l2_sources_scanned']}|{current_metrics['l2_voucher_deals_found']}|{current_metrics['l2_literal_codes_found']}"
        if alert_key != prior.get("last_alert_key"):
            alert_kind = "L2_RESULT"
            logged = sum(1 for p in platforms.values() if str((p or {}).get("status") or "") in {"AUTHENTICATED", "LOGGED_IN", "SESSION_REUSE_VERIFIED", "FULL_READY"})
            remaining = int(metrics.get("remaining_platforms") or max(0, len(platforms) - logged))
            text = "\n".join([
                f"L2: đã login {logged} nền tảng/đang cào",
                f"Kết quả L2: {current_metrics['l2_sources_scanned']} source | +{current_metrics['l2_voucher_deals_found']} voucher/deal | +{current_metrics['l2_literal_codes_found']} code",
                f"Còn lại: {remaining} platform/source groups",
                "ETA login: chưa đủ dữ liệu",
            ])

    result = {"state": "NO_MILESTONE", "sent": False}
    if text:
        result = send_telegram(text)

    out = {
        "schema": "promo.l2.milestone_alert_status.v1",
        "generated_at": now.isoformat().replace("+00:00", "Z"),
        "last_alert_key": alert_key if result.get("sent") else prior.get("last_alert_key"),
        "last_alert_kind": alert_kind if result.get("sent") else prior.get("last_alert_kind"),
        "last_metrics": current_metrics,
        "telegram_state": result.get("state"),
        "sent": bool(result.get("sent")),
        "error": result.get("error"),
    }
    STATUS_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"telegram_state": out["telegram_state"], "sent": out["sent"], "alert_kind": alert_kind}, ensure_ascii=False))


if __name__ == "__main__":
    main()
