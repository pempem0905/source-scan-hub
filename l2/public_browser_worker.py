#!/usr/bin/env python3
import hashlib, html, json, os, re, time
from pathlib import Path
from urllib import request, error

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "free-source-hunter" / "evidence.jsonl"
STATE = ROOT / "l2" / "public-state.json"
RESULTS = ROOT / "l2" / "public-results.jsonl"
MAX_ITEMS = int(os.getenv("L2_MAX_ITEMS", "20"))
MAX_SECONDS = int(os.getenv("L2_MAX_SECONDS", "480"))
START = time.time()
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36 PROMO-L2/1.0"

PROMO_WORDS = ["khuyen mai", "khuyến mãi", "ưu đãi", "uu dai", "voucher", "promo", "coupon", "discount", "cashback", "hoàn tiền", "reward", "loyalty", "member", "deal", "sale", "giảm"]
URL_HINTS = ["khuyenmai", "khuyen-mai", "uudai", "uu-dai", "promo", "voucher", "coupon", "reward", "loyalty", "deal", "offer", "food", "grab", "shopee", "tiktok"]
LOGIN_PHRASES = ["vui lòng đăng nhập để tiếp tục", "đăng nhập để tiếp tục", "please log in to continue", "sign in to continue", "login required", "authentication required", "xác thực tài khoản để tiếp tục"]
CODE_RE = re.compile(r"(?:mã|ma|code|promo code|voucher code)\s*[:\-]?\s*([A-Z0-9][A-Z0-9_-]{3,19})", re.I)
TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"\s+")


def load_json(path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def norm_text(raw):
    raw = re.sub(r"(?is)<script.*?>.*?</script>", " ", raw)
    raw = re.sub(r"(?is)<style.*?>.*?</style>", " ", raw)
    return SPACE_RE.sub(" ", html.unescape(TAG_RE.sub(" ", raw))).strip()


def score(rec):
    url = (rec.get("url") or "").lower()
    domain = (rec.get("domain") or "").lower()
    s = 0
    if any(k in url for k in URL_HINTS): s += 8
    if rec.get("via") == "seed_promo_path": s += 6
    if rec.get("radar"): s += 2
    if url.endswith("sitemap.xml"): s -= 8
    if domain.endswith("bloggiamgia.vn") or domain.endswith("picodi.com"): s -= 3
    return s


def http_fetch(url):
    req = request.Request(url, headers={"User-Agent": UA, "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.7"})
    try:
        with request.urlopen(req, timeout=14) as r:
            status = getattr(r, "status", 200)
            ctype = r.headers.get("content-type", "")
            body = r.read(1_500_000).decode("utf-8", "replace")
            return status, ctype, body, None
    except error.HTTPError as e:
        return e.code, e.headers.get("content-type", "") if e.headers else "", "", f"HTTP_{e.code}"
    except Exception as e:
        return 0, "", "", type(e).__name__


def browser_fetch(url):
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = None
            for kwargs in ({"channel": "chrome"}, {}):
                try:
                    browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"], **kwargs)
                    break
                except Exception:
                    browser = None
            if not browser:
                return None, "BROWSER_UNAVAILABLE"
            page = browser.new_page(user_agent=UA, locale="vi-VN")
            page.goto(url, wait_until="domcontentloaded", timeout=25_000)
            try:
                page.wait_for_load_state("networkidle", timeout=5_000)
            except Exception:
                pass
            out = page.content()
            browser.close()
            return out, None
    except Exception as e:
        return None, type(e).__name__


def analyze(url, status, body, browser_used=False, fetch_error=None):
    low_raw = body.lower()
    text = norm_text(body)
    low = text.lower()
    login = any(p in low for p in LOGIN_PHRASES)
    promo_hits = sorted({w for w in PROMO_WORDS if w in low})
    codes = sorted({m.group(1).upper() for m in CODE_RE.finditer(text)})[:20]
    js_shell = (len(text) < 450 and low_raw.count("<script") >= 3) or "enable javascript" in low
    if status in (401, 403, 429):
        access = "BLOCKED_DATACENTER" if status in (403, 429) else "LOGIN_REQUIRED"
    elif login:
        access = "LOGIN_REQUIRED"
    elif js_shell and not browser_used:
        access = "JS_BROWSER"
    elif status and 200 <= status < 400:
        access = "PUBLIC_OK"
    else:
        access = "ERROR"
    return {
        "access_state": access,
        "promo_signals": promo_hits,
        "code_candidates": codes,
        "text_chars": len(text),
        "content_hash": hashlib.sha256(text[:200_000].encode("utf-8", "ignore")).hexdigest() if text else None,
        "snippet": text[:900],
        "fetch_error": fetch_error,
    }


def main():
    state = load_json(STATE, {"schema_version": 1, "project_id": "PROMO-L2-ROUTER-V1", "run_count": 0, "seen": {}, "history": []})
    seen = state.setdefault("seen", {})
    records = []
    if EVIDENCE.exists():
        for line in EVIDENCE.read_text(errors="replace").splitlines():
            try:
                rec = json.loads(line)
                url = rec.get("url")
                if url and url.startswith(("http://", "https://")) and url not in seen:
                    records.append(rec)
            except Exception:
                pass
    records.sort(key=lambda r: (score(r), r.get("at", "")), reverse=True)
    picked = records[:MAX_ITEMS]
    out = []
    metrics = {"attempted": 0, "public_ok": 0, "js_browser": 0, "blocked": 0, "login_required": 0, "errors": 0, "promo_candidates": 0, "code_candidates": 0}

    for rec in picked:
        if time.time() - START > MAX_SECONDS:
            break
        url = rec["url"]
        metrics["attempted"] += 1
        status, ctype, body, ferr = http_fetch(url)
        first = analyze(url, status, body, False, ferr)
        browser_used = False
        if first["access_state"] == "JS_BROWSER":
            rendered, berr = browser_fetch(url)
            if rendered:
                body = rendered
                browser_used = True
                first = analyze(url, 200, body, True, berr)
            else:
                first["fetch_error"] = berr
        row = {
            "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "domain": rec.get("domain"),
            "url": url,
            "source_via": rec.get("via"),
            "http_status": status,
            "content_type": ctype,
            "browser_used": browser_used,
            **first,
        }
        out.append(row)
        seen[url] = {"at": row["checked_at"], "access_state": row["access_state"], "content_hash": row["content_hash"]}
        a = row["access_state"]
        if a == "PUBLIC_OK": metrics["public_ok"] += 1
        elif a == "JS_BROWSER": metrics["js_browser"] += 1
        elif a == "BLOCKED_DATACENTER": metrics["blocked"] += 1
        elif a == "LOGIN_REQUIRED": metrics["login_required"] += 1
        else: metrics["errors"] += 1
        if row["promo_signals"]: metrics["promo_candidates"] += 1
        metrics["code_candidates"] += len(row["code_candidates"])

    if out:
        with RESULTS.open("a", encoding="utf-8") as f:
            for row in out:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
    state["run_count"] = int(state.get("run_count", 0)) + 1
    state["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    state["last_run"] = metrics
    hist = state.setdefault("history", [])
    hist.append({"at": state["updated_at"], **metrics})
    state["history"] = hist[-100:]
    if len(seen) > 6000:
        keys = list(seen.keys())[-6000:]
        state["seen"] = {k: seen[k] for k in keys}
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    print(json.dumps(metrics, ensure_ascii=False))


if __name__ == "__main__":
    main()
