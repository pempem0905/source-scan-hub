#!/usr/bin/env python3
import json
import os
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_JSON = ROOT / "integration" / "hourly_summary.json"
OUT_TXT = ROOT / "integration" / "hourly_summary.txt"
OUT_STATUS = ROOT / "integration" / "hourly_report_status.json"
TZ = timezone(timedelta(hours=7))


def load(path, default=None):
    try:
        return json.loads((ROOT / path).read_text(encoding="utf-8"))
    except Exception:
        return {} if default is None else default


def now_utc():
    return datetime.now(timezone.utc)


def parse_dt(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


def age_minutes(value):
    dt = parse_dt(value)
    if not dt:
        return None
    return max(0, int((now_utc() - dt.astimezone(timezone.utc)).total_seconds() // 60))


def fmt_age(value):
    m = age_minutes(value)
    if m is None:
        return "n/a"
    if m < 60:
        return f"{m}p"
    return f"{m // 60}h{m % 60:02d}"


def num(value):
    try:
        return int(value)
    except Exception:
        return 0


def delta(current, previous, key):
    if not previous or key not in previous:
        return None
    try:
        return int(current.get(key, 0)) - int(previous.get(key, 0))
    except Exception:
        return None


def dtext(value):
    if value is None:
        return ""
    return f" ({value:+d}/1h)"


def count_platform_states(platforms):
    out = {}
    for item in (platforms or {}).values():
        state = str((item or {}).get("status") or "UNKNOWN")
        out[state] = out.get(state, 0) + 1
    return out


def build():
    engine = load("docs/data/engine.json")
    runtime = load("integration/promo-runtime-status.json")
    at = load("integration/accesstrade_status.json")
    atcat = load("integration/accesstrade_catalog_status.json")
    affiliates = load("integration/affiliate_networks_status.json")
    l2 = load("l2/auth-status.json")
    previous = load("integration/hourly_summary.json") if OUT_JSON.exists() else {}
    prev_metrics = previous.get("metrics") or {}

    status = engine.get("status") or {}
    master = engine.get("master_input") or load("integration/master_input_status.json")
    canonical = runtime.get("canonical") or {}
    networks = affiliates.get("networks") or {}
    ecomobi = networks.get("ECOMOBI") or {}
    masoffer = networks.get("MASOFFER") or {}
    preauth = l2.get("preauth") or {}
    platform_states = count_platform_states(l2.get("platforms"))

    metrics = {
        "master_sources": num(master.get("record_count")),
        "active_sources": num(master.get("active_input_count")),
        "review_sources": num(master.get("review_input_count")),
        "hunter_domains": num(status.get("master_domains") or master.get("source_hunter_domains")),
        "seen_urls": num(status.get("seen_urls")),
        "promo_scanned_sources": num(canonical.get("scanned_sources")),
        "actionable_offers": num(canonical.get("actionable_offers")),
        "literal_codes": num(canonical.get("literal_codes")),
        "at_campaigns": num(atcat.get("approved_campaign_count")),
        "at_merchants": num(atcat.get("merchant_with_offer_count")),
        "at_offers": num(atcat.get("active_offer_count")),
        "at_discounted_products": num(atcat.get("discounted_product_count")),
        "at_tiktok_products": num(at.get("tiktok_product_count")),
        "ecomobi_candidates": num(ecomobi.get("candidate_rows")),
        "masoffer_candidates": num(masoffer.get("candidate_rows")),
    }

    alerts = []
    rate403 = status.get("last_run", {}).get("rate403")
    try:
        if float(rate403 or 0) >= 0.50:
            alerts.append(f"Hunter 403 cao {float(rate403)*100:.1f}% → giảm retry host bị chặn, ưu tiên nguồn official/Common Crawl.")
    except Exception:
        pass
    cat_age = age_minutes(atcat.get("generated_at"))
    if atcat.get("tokens_configured") and metrics["at_campaigns"] == 0 and (cat_age is None or cat_age < 180):
        alerts.append("AccessTrade: token hoạt động nhưng campaign vẫn 0 → tiếp tục fallback API v1 + cashback và quét merchant riêng.")
    if ecomobi.get("state") == "API_NOT_RESOLVED":
        alerts.append("Ecomobi: credential đã nhận, endpoint API vẫn chưa resolve.")
    if masoffer.get("state") == "API_NOT_RESOLVED":
        alerts.append("MasOffer: credential đã nhận, endpoint/response vẫn chưa resolve.")
    runtime_age = age_minutes(runtime.get("generated_at"))
    if runtime_age is not None and runtime_age > 120:
        alerts.append(f"PROMO canonical telemetry cũ {fmt_age(runtime.get('generated_at'))} → cần ưu tiên đồng bộ counter writer/dashboard.")
    if preauth.get("free_daily_quota_wait"):
        retry = preauth.get("next_retry_at")
        alerts.append(f"L2 đang chờ quota Browser Run miễn phí; retry kế tiếp {retry or 'tự động'}.")
    alerts = alerts[:5]

    local_now = now_utc().astimezone(TZ)
    lines = [
        f"📊 PROMO MASTER — {local_now:%H:%M %d/%m}",
        "",
        "🔎 SOURCE",
        f"• Master: {metrics['master_sources']}{dtext(delta(metrics, prev_metrics, 'master_sources'))} | Active {metrics['active_sources']} | Review {metrics['review_sources']}",
        f"• Hunter: {metrics['hunter_domains']} domains{dtext(delta(metrics, prev_metrics, 'hunter_domains'))} | Seen {metrics['seen_urls']:,}",
        f"• Lần quét gần nhất: +{num(status.get('last_run', {}).get('new_domains'))} domains / {num(status.get('last_run', {}).get('processed'))} URL | lỗi {num(status.get('last_run', {}).get('errors'))}",
        "",
        "🎟 PROMO / CODE",
        f"• Canonical B{canonical.get('batch','?')}: scanned {metrics['promo_scanned_sources']} | deals {metrics['actionable_offers']} | codes {metrics['literal_codes']} | READY {num(canonical.get('ready_queue'))}",
        f"• Telemetry age: {fmt_age(runtime.get('generated_at'))}",
        "",
        "🟠 ACCESSTRADE",
        f"• Campaign approved: {metrics['at_campaigns']}{dtext(delta(metrics, prev_metrics, 'at_campaigns'))} | merchants có offer: {metrics['at_merchants']}",
        f"• Promo/deal: {metrics['at_offers']}{dtext(delta(metrics, prev_metrics, 'at_offers'))} | SP giảm giá: {metrics['at_discounted_products']}{dtext(delta(metrics, prev_metrics, 'at_discounted_products'))}",
        f"• TikTok Shop: {metrics['at_tiktok_products']} sản phẩm | AT state: {atcat.get('state','?')}/{at.get('state','?')}",
        "",
        "🟣 AFFILIATE KHÁC",
        f"• Ecomobi: {ecomobi.get('state','?')} | candidates {metrics['ecomobi_candidates']}",
        f"• MasOffer: {masoffer.get('state','?')} | candidates {metrics['masoffer_candidates']}",
        "",
        "🔐 L2",
        f"• {l2.get('mode','?')} | bridge {preauth.get('bridge_status','?')} | profiles {sum(platform_states.values())}",
    ]
    if alerts:
        lines += ["", "🛠 PHÂN TÍCH / CẢI TIẾN"] + [f"• {x}" for x in alerts]
    else:
        lines += ["", "✅ Chưa có cải tiến khẩn cấp trong giờ này."]
    text = "\n".join(lines)
    if len(text) > 3900:
        text = text[:3890] + "…"

    return {
        "schema": "promo.hourly_summary.v1",
        "generated_at": now_utc().isoformat().replace("+00:00", "Z"),
        "local_time": local_now.isoformat(),
        "metrics": metrics,
        "alerts": alerts,
        "platform_states": platform_states,
        "text": text,
    }


def send_telegram(text):
    token = (os.getenv("TELEGRAM_BOT_TOKEN") or "").strip()
    chat_id = (os.getenv("TELEGRAM_CHAT_ID") or "").strip()
    if not token or not chat_id:
        return {"state": "CREDENTIALS_MISSING", "sent": False}
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = urllib.parse.urlencode({"chat_id": chat_id, "text": text, "disable_web_page_preview": "true"}).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        return {"state": "SENT" if payload.get("ok") else "API_ERROR", "sent": bool(payload.get("ok"))}
    except Exception as exc:
        return {"state": "SEND_ERROR", "sent": False, "error": f"{type(exc).__name__}:{exc}"[:300]}


def main():
    summary = build()
    result = send_telegram(summary["text"])
    OUT_JSON.write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    OUT_TXT.write_text(summary["text"] + "\n", encoding="utf-8")
    status = {
        "schema": "promo.hourly_report_status.v1",
        "generated_at": summary["generated_at"],
        "telegram_state": result.get("state"),
        "sent": result.get("sent", False),
        "error": result.get("error"),
        "alert_count": len(summary.get("alerts") or []),
    }
    OUT_STATUS.write_text(json.dumps(status, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(status, ensure_ascii=False))


if __name__ == "__main__":
    main()
