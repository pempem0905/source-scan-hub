#!/usr/bin/env python3
import hashlib, html, json, os, re, time
from pathlib import Path
from urllib import request, error
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
MASTER_INPUT = ROOT / "integration" / "master_input_sources_v1.jsonl"
STATE = ROOT / "l2" / "public-state.json"
RESULTS = ROOT / "l2" / "public-results.jsonl"
CANDIDATES = ROOT / "l2" / "candidate-queue.jsonl"
MAX_ITEMS = int(os.getenv("L2_MAX_ITEMS", "20"))
MAX_SECONDS = int(os.getenv("L2_MAX_SECONDS", "480"))
START = time.time()
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36 PROMO-L2/2.0"

PROMO_WORDS = ["khuyen mai", "khuyến mãi", "ưu đãi", "uu dai", "voucher", "promo", "coupon", "discount", "cashback", "hoàn tiền", "reward", "loyalty", "member", "deal", "sale", "giảm"]
URL_HINTS = ["khuyenmai", "khuyen-mai", "uudai", "uu-dai", "promo", "voucher", "coupon", "reward", "loyalty", "deal", "offer"]
LOGIN_PHRASES = ["vui lòng đăng nhập để tiếp tục", "đăng nhập để tiếp tục", "please log in to continue", "sign in to continue", "login required", "authentication required", "xác thực tài khoản để tiếp tục"]
LOGIN_URL_RE = re.compile(r"/(login|signin|sign-in|dang-nhap)(?:/|$|\?)", re.I)
CODE_RE = re.compile(r"(?P<trigger>mã(?:\s+(?:giảm\s*giá|ưu\s*đãi|khuyến\s*mãi))?|ma(?:\s+(?:giam\s*gia|uu\s*dai|khuyen\s*mai))?|promo\s*code|voucher\s*code|coupon\s*code|nhập\s*mã|nhap\s*ma|use\s*code|apply\s*code)\s*[:\-]?\s*(?P<code>[A-Z0-9][A-Z0-9_-]{3,19})", re.I)
STRONG_TRIGGER_RE = re.compile(r"(mã\s+(?:giảm\s*giá|ưu\s*đãi|khuyến\s*mãi)|ma\s+(?:giam\s*gia|uu\s*dai|khuyen\s*mai)|promo\s*code|voucher\s*code|coupon\s*code|nhập\s*mã|nhap\s*ma|use\s*code|apply\s*code)", re.I)
BENEFIT_RE = re.compile(r"(giảm|giam|discount|\boff\b|cashback|hoàn\s*tiền|hoan\s*tien|tặng|tang|miễn\s*phí|mien\s*phi|free|voucher|coupon|%|\b\d{1,3}[.,]?\d{3}\s*(?:đ|d|vnd)\b)", re.I)
BAD_CODE_CONTEXT_RE = re.compile(r"(mã\s*sản\s*phẩm|ma\s*san\s*pham|product\s*code|sku|model|mã\s*hàng|ma\s*hang|mã\s*đơn|ma\s*don|order\s*code|collection|bộ\s*sưu\s*tập|bo\s*suu\s*tap)", re.I)
TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"\s+")
CODE_STOP = {"HTML", "HTTP", "HTTPS", "LOGIN", "SIGNIN", "PROMO", "VOUCHER", "COUPON", "DISCOUNT", "UNDEFINED", "NULL", "TRUE", "FALSE"}


def load_json(path, default):
    try: return json.loads(path.read_text())
    except Exception: return default


def norm_text(raw):
    raw = re.sub(r"(?is)<script.*?>.*?</script>", " ", raw)
    raw = re.sub(r"(?is)<style.*?>.*?</style>", " ", raw)
    return SPACE_RE.sub(" ", html.unescape(TAG_RE.sub(" ", raw))).strip()


def extract_codes(text, content_type=""):
    if "xml" in (content_type or "").lower():
        return [], []
    good, evidence = [], []
    for m in CODE_RE.finditer(text):
        code = m.group("code").upper().strip("_-")
        if len(code) < 4 or code in CODE_STOP:
            continue
        left = max(0, m.start() - 140); right = min(len(text), m.end() + 180)
        context = text[left:right]
        if BAD_CODE_CONTEXT_RE.search(context):
            continue
        trigger = m.group("trigger")
        strong = bool(STRONG_TRIGGER_RE.search(trigger))
        economics = bool(BENEFIT_RE.search(context))
        has_digit = any(c.isdigit() for c in code)
        if not strong and not (has_digit and economics):
            continue
        confidence = 0.72 + (0.16 if strong else 0) + (0.10 if economics else 0)
        confidence = min(0.98, confidence)
        if confidence < 0.80:
            continue
        if code not in good:
            good.append(code)
            evidence.append({"code": code, "confidence": round(confidence, 2), "trigger": trigger, "context": context[:420]})
    return good[:12], evidence[:12]


def score(rec):
    urls = rec.get("entry_points") or []
    s = int(rec.get("crawl_priority") or 0)
    if any(any(k in u.lower() for k in URL_HINTS) for u in urls[:10]): s += 10
    if rec.get("access_class") == "JS_BROWSER": s += 8
    return s


def http_fetch(url):
    req = request.Request(url, headers={"User-Agent": UA, "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.7"})
    try:
        with request.urlopen(req, timeout=14) as r:
            status = getattr(r, "status", 200); ctype = r.headers.get("content-type", "")
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
                    browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"], **kwargs); break
                except Exception: browser = None
            if not browser: return None, "BROWSER_UNAVAILABLE"
            page = browser.new_page(user_agent=UA, locale="vi-VN")
            page.goto(url, wait_until="domcontentloaded", timeout=25_000)
            try: page.wait_for_load_state("networkidle", timeout=5_000)
            except Exception: pass
            out = page.content(); browser.close(); return out, None
    except Exception as e:
        return None, type(e).__name__


def analyze(url, status, ctype, body, browser_used=False, fetch_error=None):
    low_raw = body.lower(); text = norm_text(body); low = text.lower()
    login = bool(LOGIN_URL_RE.search(urlsplit(url).path)) or any(p in low for p in LOGIN_PHRASES)
    promo_hits = sorted({w for w in PROMO_WORDS if w in low})
    codes, code_evidence = extract_codes(text, ctype)
    js_shell = (len(text) < 450 and low_raw.count("<script") >= 3) or "enable javascript" in low
    if status in (403, 429): access = "BLOCKED_DATACENTER"
    elif status == 401 or login: access = "LOGIN_REQUIRED"
    elif js_shell and not browser_used: access = "JS_BROWSER"
    elif status and 200 <= status < 400: access = "PUBLIC_OK"
    else: access = "ERROR"
    return {
        "access_state": access, "promo_signals": promo_hits, "code_candidates": codes,
        "code_evidence": code_evidence, "text_chars": len(text),
        "content_hash": hashlib.sha256(text[:200_000].encode("utf-8", "ignore")).hexdigest() if text else None,
        "snippet": text[:900], "fetch_error": fetch_error,
    }


def main():
    state = load_json(STATE, {"schema_version": 2, "project_id": "PROMO-L2-ROUTER-V1", "run_count": 0, "seen": {}, "history": []})
    seen = state.setdefault("seen", {})
    sources = []
    if MASTER_INPUT.exists():
        for line in MASTER_INPUT.read_text(errors="replace").splitlines():
            try: rec = json.loads(line)
            except Exception: continue
            if rec.get("access_class") in {"AUTHORIZED_ACCOUNT", "RESIDENTIAL_REQUIRED", "MANUAL_ONLY"}: continue
            sources.append(rec)
    sources.sort(key=score, reverse=True)
    work = []
    for rec in sources:
        eps = rec.get("entry_points") or [rec.get("canonical_root_url")]
        eps = sorted([u for u in eps if u], key=lambda u: (0 if any(k in u.lower() for k in URL_HINTS) else 1, len(u)))
        for url in eps[:8]:
            if url not in seen:
                work.append((rec, url))
    work = work[:MAX_ITEMS]
    out = []
    metrics = {"attempted": 0, "public_ok": 0, "js_browser": 0, "blocked": 0, "login_required": 0, "errors": 0, "promo_candidates": 0, "code_candidates": 0, "shadow_ready": 0}
    existing_keys = set()
    if CANDIDATES.exists():
        for line in CANDIDATES.read_text(errors="replace").splitlines()[-5000:]:
            try: existing_keys.add(json.loads(line).get("idempotency_key"))
            except Exception: pass
    shadow = []

    for rec, url in work:
        if time.time() - START > MAX_SECONDS: break
        metrics["attempted"] += 1
        status, ctype, body, ferr = http_fetch(url)
        first = analyze(url, status, ctype, body, False, ferr); browser_used = False
        if first["access_state"] == "JS_BROWSER":
            rendered, berr = browser_fetch(url)
            if rendered:
                body = rendered; browser_used = True; first = analyze(url, 200, "text/html", body, True, berr)
            else: first["fetch_error"] = berr
        row = {
            "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "source_id": rec.get("source_id"),
            "registrable_domain": rec.get("registrable_domain"), "vertical": rec.get("vertical"), "url": url,
            "http_status": status, "content_type": ctype, "browser_used": browser_used, **first,
        }
        out.append(row); seen[url] = {"at": row["checked_at"], "access_state": row["access_state"], "content_hash": row["content_hash"]}
        a = row["access_state"]
        if a == "PUBLIC_OK": metrics["public_ok"] += 1
        elif a == "JS_BROWSER": metrics["js_browser"] += 1
        elif a == "BLOCKED_DATACENTER": metrics["blocked"] += 1
        elif a == "LOGIN_REQUIRED": metrics["login_required"] += 1
        else: metrics["errors"] += 1
        if row["promo_signals"]: metrics["promo_candidates"] += 1
        metrics["code_candidates"] += len(row["code_candidates"])
        for ev in row["code_evidence"]:
            key = hashlib.sha256(f"{rec.get('source_id')}|{url}|{ev['code']}".encode()).hexdigest()
            if key in existing_keys: continue
            existing_keys.add(key); metrics["shadow_ready"] += 1
            shadow.append({
                "schema": "promo.l2.shadow_candidate.v1", "idempotency_key": key, "status": "SHADOW_READY",
                "source_id": rec.get("source_id"), "registrable_domain": rec.get("registrable_domain"),
                "vertical": rec.get("vertical"), "evidence_url": url, "literal_code": ev["code"],
                "confidence": ev["confidence"], "context": ev["context"], "checked_at": row["checked_at"],
                "production_commit_allowed": False,
            })

    if out:
        with RESULTS.open("a", encoding="utf-8") as f:
            for row in out: f.write(json.dumps(row, ensure_ascii=False) + "\n")
    if shadow:
        with CANDIDATES.open("a", encoding="utf-8") as f:
            for row in shadow: f.write(json.dumps(row, ensure_ascii=False) + "\n")
    state["schema_version"] = 2; state["run_count"] = int(state.get("run_count", 0)) + 1
    state["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()); state["last_run"] = metrics
    hist = state.setdefault("history", []); hist.append({"at": state["updated_at"], **metrics}); state["history"] = hist[-100:]
    if len(seen) > 10000:
        keys = list(seen.keys())[-10000:]; state["seen"] = {k: seen[k] for k in keys}
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    print(json.dumps(metrics, ensure_ascii=False))


if __name__ == "__main__":
    main()
