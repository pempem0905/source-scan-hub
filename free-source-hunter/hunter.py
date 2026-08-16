#!/usr/bin/env python3
import concurrent.futures
import datetime as dt
import html.parser
import json
import os
import random
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATE_PATH = ROOT / "state.json"
STATUS_PATH = ROOT / "status.json"
DOMAINS_PATH = ROOT / "master_domains.txt"
SEEN_PATH = ROOT / "seen_urls.txt"
EVIDENCE_PATH = ROOT / "evidence.jsonl"

USER_AGENT = "SourceScanFree/1.0 (Vietnam promo source discovery; GitHub Actions; contact via repository)"
MAX_RUN_SECONDS = int(os.getenv("FREE_HUNTER_MAX_SECONDS", "600"))
MAX_FETCHES = int(os.getenv("FREE_HUNTER_MAX_FETCHES", "320"))
HTTP_WORKERS = int(os.getenv("FREE_HUNTER_HTTP_WORKERS", "6"))
CC_PATTERNS_PER_RUN = int(os.getenv("FREE_HUNTER_CC_PATTERNS", "2"))
CC_LIMIT = int(os.getenv("FREE_HUNTER_CC_LIMIT", "250"))
MAX_FRONTIER = 40000
MAX_BODY = 600000

PROMO_PATHS = [
    "/khuyen-mai", "/khuyenmai", "/uu-dai", "/uudai", "/voucher", "/vouchers",
    "/promotion", "/promotions", "/promo", "/offers", "/deals", "/sale",
]
PROMO_RE = re.compile(r"(khuyến\s*mại|khuyen\s*mai|ưu\s*đãi|uu\s*dai|mã\s*giảm\s*giá|ma\s*giam\s*gia|voucher|coupon|promotion|promo\s*code|offers?|deals?)", re.I)
VN_RE = re.compile(r"(việt\s*nam|viet\s*nam|vietnam|\bvnd\b|₫|hà\s*nội|ha\s*noi|hồ\s*chí\s*minh|ho\s*chi\s*minh|tp\.?hcm|saigon)", re.I)
NOISE_HOST_RE = re.compile(r"(^|\.)(facebook|fb|instagram|linkedin|twitter|x|pinterest|tiktok|youtube|youtu|zalo|telegram|whatsapp|threads|reddit)\.(com|me|be|co|vn|net|org)$|(^|\.)(google|googleapis|gstatic|doubleclick|cloudflare|jsdelivr|unpkg|schema|w3)\.", re.I)
ASSET_RE = re.compile(r"\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|woff2?|ttf|eot|pdf|zip|rar|7z|mp4|mp3|avi|mov)(?:$|\?)", re.I)
RADAR_RE = re.compile(r"(bloggiamgia|picodi|magiamgia|giamgia|coupon|voucher|sandeal|dealhot|dealngon|accesstrade|adpia|masoffer|involve\.asia|ecomobi)", re.I)

CC_PATTERNS = [
    "*.vn/*khuyen-mai*", "*.vn/*khuyenmai*", "*.vn/*uu-dai*", "*.vn/*uudai*",
    "*.vn/*voucher*", "*.vn/*promotion*", "*.vn/*offers*", "*.vn/*deals*", "*.vn/*sale*",
    "*.com/vn/*khuyen-mai*", "*.com/vn/*uu-dai*", "*.com/vn/*voucher*", "*.com/vn/*promotion*",
    "*.com/vi-vn/*khuyen-mai*", "*.com/vi-vn/*uu-dai*", "*.com/vi-vn/*voucher*", "*.com/vi-vn/*promotion*",
    "*.net/vn/*khuyen-mai*", "*.net/vn/*uu-dai*", "*.com/vietnam/*promotion*",
]

DEFAULT_SEEDS = [
    "https://bloggiamgia.vn/", "https://www.picodi.com/vn/", "https://shopee.vn/", "https://www.lazada.vn/",
    "https://tiki.vn/", "https://www.grab.com/vn/", "https://www.traveloka.com/vi-vn/",
    "https://www.vietcombank.com.vn/", "https://techcombank.com/", "https://www.vpbank.com.vn/",
    "https://www.acb.com.vn/", "https://www.sacombank.com.vn/", "https://www.mbbank.com.vn/",
    "https://www.vib.com.vn/", "https://www.hdbank.com.vn/", "https://www.ocb.com.vn/",
    "https://vincom.com.vn/", "https://www.aeon.com.vn/", "https://lottemallwestlakehanoi.vn/",
    "https://www.thisomallsala.vn/vn", "https://shopping.saigoncentre.com.vn/", "https://www.crescentmall.com.vn/",
    "https://gigamall.com.vn/", "https://centralretail.com.vn/", "https://homefarm.vn/", "https://www.winmart.vn/",
    "https://co-opmart.com.vn/", "https://mmvietnam.com/", "https://emart.com.vn/", "https://www.thegioididong.com/",
    "https://www.dienmayxanh.com/", "https://fptshop.com.vn/", "https://cellphones.com.vn/", "https://viettelstore.vn/",
    "https://nhathuoclongchau.com.vn/", "https://www.pharmacity.vn/", "https://www.guardian.com.vn/", "https://www.watsons.vn/",
    "https://www.pnj.com.vn/", "https://www.uniqlo.com/vn/", "https://www.decathlon.vn/", "https://www.canifa.com/",
    "https://juno.vn/", "https://www.highlandscoffee.com.vn/", "https://phuclong.com.vn/", "https://kfcvietnam.com.vn/",
    "https://lotteria.vn/", "https://jollibee.com.vn/", "https://www.cgv.vn/", "https://www.galaxycine.vn/",
]

socket.setdefaulttimeout(12)
SSL_CONTEXT = ssl.create_default_context()


def utcnow():
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def normalize_url(raw, base=None):
    try:
        u = urllib.parse.urljoin(base or raw, raw) if base else raw
        p = urllib.parse.urlsplit(u)
        if p.scheme not in ("http", "https") or not p.hostname:
            return None
        host = p.hostname.lower().strip(".")
        if host.startswith("www."):
            host = host[4:]
        port = p.port
        netloc = host
        if port and not ((p.scheme == "https" and port == 443) or (p.scheme == "http" and port == 80)):
            netloc = f"{host}:{port}"
        qs = urllib.parse.parse_qsl(p.query, keep_blank_values=True)
        clean = []
        for k, v in qs:
            kl = k.lower()
            if kl.startswith("utm_") or kl in {"gclid", "fbclid", "clickid", "click_id", "aff", "aff_id", "affiliate_id", "subid", "sub_id"}:
                continue
            clean.append((k, v))
        return urllib.parse.urlunsplit((p.scheme, netloc, p.path or "/", urllib.parse.urlencode(clean), ""))
    except Exception:
        return None


def host_of(raw):
    try:
        h = urllib.parse.urlsplit(raw).hostname or ""
        h = h.lower().strip(".")
        return h[4:] if h.startswith("www.") else h
    except Exception:
        return ""


def root_of(raw):
    try:
        p = urllib.parse.urlsplit(raw)
        return f"{p.scheme}://{p.netloc}/"
    except Exception:
        return raw


def valid_host(host):
    if not host or NOISE_HOST_RE.search(host):
        return False
    if host in {"localhost", "127.0.0.1"}:
        return False
    return "." in host


def market_relevant(url, text=""):
    h = host_of(url)
    if h.endswith(".vn"):
        return True
    path = urllib.parse.urlsplit(url).path.lower()
    if re.search(r"/(vn|vi-vn|vi_vn|vietnam)(/|$)", path):
        return True
    sample = text[:250000]
    return bool(VN_RE.search(sample))


def looks_promo(url, text=""):
    path = urllib.parse.urlsplit(url).path.lower()
    return any(x in path for x in ["khuyen", "uu-dai", "uudai", "voucher", "coupon", "promo", "offer", "deal", "sale"]) or bool(PROMO_RE.search(text[:250000]))


class LinkParser(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links = []
    def handle_starttag(self, tag, attrs):
        if tag.lower() not in ("a", "link"):
            return
        d = dict(attrs)
        href = d.get("href")
        if href and len(self.links) < 1200:
            self.links.append(href)


def request_bytes(url, max_bytes=MAX_BODY):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml,application/xml,text/xml,text/plain,*/*;q=0.5"})
    with urllib.request.urlopen(req, timeout=12, context=SSL_CONTEXT) as r:
        status = getattr(r, "status", 200)
        ctype = (r.headers.get("content-type") or "").lower()
        final = r.geturl()
        data = r.read(max_bytes)
        return status, ctype, final, data


def decode_body(data, ctype=""):
    enc = "utf-8"
    m = re.search(r"charset=([\w.-]+)", ctype)
    if m:
        enc = m.group(1)
    try:
        return data.decode(enc, errors="replace")
    except Exception:
        return data.decode("utf-8", errors="replace")


def parse_sitemap(text, base):
    urls = []
    for m in re.finditer(r"<loc>\s*([^<]+?)\s*</loc>", text, re.I):
        u = normalize_url(m.group(1).strip(), base)
        if u and len(urls) < 1000:
            urls.append(u)
    return urls


def fetch_task(task):
    url = task["url"]
    out = {"url": url, "via": task.get("via", "frontier"), "status": 0, "error": None, "new_tasks": [], "sources": []}
    try:
        status, ctype, final, data = request_bytes(url)
        out["status"] = status
        final_n = normalize_url(final) or url
        text = decode_body(data, ctype)
        h = host_of(final_n)
        if not valid_host(h):
            return out
        relevant = market_relevant(final_n, text)
        promo = looks_promo(final_n, text)
        if relevant and (promo or task.get("seed") or task.get("via") in {"common_crawl", "radar_out"}):
            out["sources"].append({"domain": h, "url": final_n, "via": task.get("via", "frontier"), "radar": bool(RADAR_RE.search(h))})
        is_xml = "xml" in ctype or final_n.lower().endswith(".xml")
        if is_xml:
            for u in parse_sitemap(text, final_n):
                uh = host_of(u)
                if uh == h and (looks_promo(u) or len(out["new_tasks"]) < 80):
                    out["new_tasks"].append({"url": u, "via": "sitemap"})
            return out
        if "html" not in ctype and "text" not in ctype and not text.lstrip().lower().startswith("<!doctype"):
            return out
        parser = LinkParser()
        try:
            parser.feed(text[:MAX_BODY])
        except Exception:
            pass
        same = 0
        external = 0
        radar_page = bool(RADAR_RE.search(h))
        for href in parser.links:
            u = normalize_url(href, final_n)
            if not u or ASSET_RE.search(u):
                continue
            uh = host_of(u)
            if not valid_host(uh):
                continue
            if uh == h:
                if looks_promo(u) and same < 80:
                    out["new_tasks"].append({"url": u, "via": "internal_promo"})
                    same += 1
            elif external < 20 and (radar_page or looks_promo(u)):
                out["new_tasks"].append({"url": root_of(u), "via": "radar_out" if radar_page else "external_promo"})
                external += 1
        return out
    except urllib.error.HTTPError as e:
        out["status"] = e.code
        out["error"] = f"HTTP {e.code}"
        return out
    except Exception as e:
        out["error"] = type(e).__name__ + ": " + str(e)[:160]
        return out


def latest_cc_index():
    req = urllib.request.Request("https://index.commoncrawl.org/collinfo.json", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15, context=SSL_CONTEXT) as r:
        rows = json.loads(r.read(500000).decode("utf-8"))
    if not rows:
        return None
    return rows[0].get("id")


def cc_query(index_id, pattern, limit=CC_LIMIT):
    params = urllib.parse.urlencode({"url": pattern, "output": "json", "filter": "status:200", "limit": str(limit)})
    url = f"https://index.commoncrawl.org/{urllib.parse.quote(index_id)}-index?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/x-ndjson,text/plain,*/*"})
    try:
        with urllib.request.urlopen(req, timeout=30, context=SSL_CONTEXT) as r:
            text = r.read(2000000).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code in (429, 503):
            return []
        raise
    out = []
    for line in text.splitlines():
        try:
            row = json.loads(line)
            u = normalize_url(row.get("url", ""))
            if u and valid_host(host_of(u)):
                out.append(u)
        except Exception:
            pass
    return out


def load_json(path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def load_lines(path):
    if not path.exists():
        return []
    return [x.strip() for x in path.read_text(errors="replace").splitlines() if x.strip()]


def write_lines(path, values):
    path.write_text("\n".join(sorted(set(values))) + ("\n" if values else ""))


def main():
    started = time.time()
    now = utcnow()
    state = load_json(STATE_PATH, {"version": 1, "run_count": 0, "cc_pattern_cursor": 0, "frontier": [], "history": []})
    domains = set(load_lines(DOMAINS_PATH))
    seen = set(load_lines(SEEN_PATH))
    frontier = deque(state.get("frontier") or [])
    evidence_new = []

    def enqueue(raw, via="frontier", seed=False):
        if len(frontier) >= MAX_FRONTIER:
            return False
        u = normalize_url(raw)
        if not u or ASSET_RE.search(u):
            return False
        h = host_of(u)
        if not valid_host(h) or u in seen:
            return False
        seen.add(u)
        frontier.append({"url": u, "via": via, "seed": bool(seed)})
        return True

    if state.get("run_count", 0) == 0 and not frontier:
        for s in DEFAULT_SEEDS:
            enqueue(s, "curated_seed", True)
            root = root_of(s)
            enqueue(urllib.parse.urljoin(root, "sitemap.xml"), "seed_sitemap", True)
            for p in PROMO_PATHS:
                enqueue(urllib.parse.urljoin(root, p.lstrip("/")), "seed_promo_path", True)

    cc_index = state.get("cc_index")
    try:
        latest = latest_cc_index()
        if latest:
            cc_index = latest
    except Exception:
        pass

    cc_added = 0
    cc_patterns = []
    if cc_index:
        cursor = int(state.get("cc_pattern_cursor", 0)) % len(CC_PATTERNS)
        for j in range(CC_PATTERNS_PER_RUN):
            pattern = CC_PATTERNS[(cursor + j) % len(CC_PATTERNS)]
            cc_patterns.append(pattern)
            try:
                urls = cc_query(cc_index, pattern)
                for u in urls:
                    if enqueue(u, "common_crawl", False):
                        cc_added += 1
            except Exception:
                pass
            time.sleep(1.4 + random.random())
        state["cc_pattern_cursor"] = (cursor + CC_PATTERNS_PER_RUN) % len(CC_PATTERNS)

    initial_domains = len(domains)
    processed = errors = count403 = count429 = 0
    batch_size = min(MAX_FETCHES, len(frontier))
    tasks = [frontier.popleft() for _ in range(batch_size)]

    with concurrent.futures.ThreadPoolExecutor(max_workers=HTTP_WORKERS) as ex:
        future_map = {ex.submit(fetch_task, t): t for t in tasks}
        for fut in concurrent.futures.as_completed(future_map):
            if time.time() - started > MAX_RUN_SECONDS - 20:
                for f, t in future_map.items():
                    if not f.done():
                        frontier.appendleft(t)
                break
            try:
                result = fut.result()
            except Exception:
                errors += 1
                continue
            processed += 1
            st = int(result.get("status") or 0)
            if st == 403:
                count403 += 1
            if st == 429:
                count429 += 1
            if result.get("error"):
                errors += 1
            for src in result.get("sources") or []:
                d = src["domain"]
                if d not in domains:
                    domains.add(d)
                    evidence_new.append({"at": now, **src})
                    root = root_of(src["url"])
                    enqueue(root, "new_domain_root", True)
                    enqueue(urllib.parse.urljoin(root, "sitemap.xml"), "new_domain_sitemap", True)
                    for p in PROMO_PATHS[:6]:
                        enqueue(urllib.parse.urljoin(root, p.lstrip("/")), "new_domain_promo", True)
            for t in result.get("new_tasks") or []:
                enqueue(t.get("url"), t.get("via", "link"), False)

    new_domains = len(domains) - initial_domains
    state["version"] = 1
    state["run_count"] = int(state.get("run_count", 0)) + 1
    state["cc_index"] = cc_index
    state["frontier"] = list(frontier)[:MAX_FRONTIER]
    run_record = {
        "at": now,
        "duration_s": round(time.time() - started, 1),
        "processed": processed,
        "new_domains": new_domains,
        "cc_added": cc_added,
        "frontier_pending": len(frontier),
        "errors": errors,
        "rate403": round((count403 / processed * 100) if processed else 0, 3),
        "rate429": round((count429 / processed * 100) if processed else 0, 3),
        "cc_patterns": cc_patterns,
    }
    history = list(state.get("history") or [])
    history.append(run_record)
    state["history"] = history[-30:]
    state["updated_at"] = utcnow()

    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    write_lines(DOMAINS_PATH, domains)
    write_lines(SEEN_PATH, seen)
    if evidence_new:
        with EVIDENCE_PATH.open("a", encoding="utf-8") as f:
            for row in evidence_new:
                f.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    elif not EVIDENCE_PATH.exists():
        EVIDENCE_PATH.write_text("")

    recent = state["history"][-6:]
    status = {
        "mode": "FREE_COMMON_CRAWL_GITHUB",
        "running": True,
        "updated_at": state["updated_at"],
        "run_count": state["run_count"],
        "master_domains": len(domains),
        "frontier_pending": len(frontier),
        "seen_urls": len(seen),
        "latest_common_crawl": cc_index,
        "last_run": run_record,
        "last_6_runs_new_domains": sum(int(r.get("new_domains", 0)) for r in recent),
        "estimated_monthly_github_minutes": 4 * 30 * (MAX_RUN_SECONDS / 60),
        "cost_target_usd": 0,
    }
    STATUS_PATH.write_text(json.dumps(status, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    print(json.dumps(status, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
