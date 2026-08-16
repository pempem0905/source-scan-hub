#!/usr/bin/env python3
import hashlib
import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "free-source-hunter" / "evidence.jsonl"
DOMAINS = ROOT / "free-source-hunter" / "master_domains.txt"
PROMO_EXPORT = ROOT / "integration" / "promo-source-export.jsonl"
LEGACY_SEED = ROOT / "integration" / "legacy-source-seed.jsonl"
L2_STATE = ROOT / "l2" / "public-state.json"
OUT = ROOT / "integration" / "master_input_sources_v1.jsonl"
STATUS = ROOT / "integration" / "master_input_status.json"
DISPATCH = ROOT / "integration" / "promo_dispatch_plan_v1.jsonl"

MULTI_SUFFIX = {
    "com.vn", "net.vn", "org.vn", "edu.vn", "gov.vn", "id.vn", "biz.vn",
    "info.vn", "name.vn", "pro.vn", "health.vn", "int.vn", "ac.vn",
}
TRACKING = {
    "gclid", "fbclid", "clickid", "click_id", "aff", "aff_id", "affiliate_id",
    "subid", "sub_id", "ref", "referrer",
}
RADAR_RE = re.compile(r"(bloggiamgia|picodi|magiamgia|giamgia|coupon|voucher|sandeal|dealhot|dealngon|accesstrade|adpia|masoffer|involve\.asia|ecomobi|noti\.sale)", re.I)
BANK_RE = re.compile(r"(bank|ngan.?hang|ngân.?hàng|vpbank|vietcombank|techcombank|acb|mbbank|hdbank|ocb|vib|sacombank|card|visa|mastercard|jcb)", re.I)
PAY_RE = re.compile(r"(momo|zalopay|vnpay|shopeepay|wallet|payment|paylater|spaylater)", re.I)
TRAVEL_RE = re.compile(r"(travel|hotel|airline|flight|booking|agoda|traveloka|trip\.com|grab|transport|mobility)", re.I)
FOOD_RE = re.compile(r"(food|restaurant|coffee|cafe|kfc|jollibee|lotteria|phuclong|highlands|pizza|grabfood|shopeefood)", re.I)
RETAIL_RE = re.compile(r"(shop|store|retail|mart|mall|shopee|lazada|tiki|fptshop|cellphones|dienmay|thegioididong|winmart|aeon|pnj|pharmacy|pharmacity|longchau|fashion|beauty)", re.I)
LOYALTY_RE = re.compile(r"(loyalty|reward|member|membership|smember|point|redeem|đổi.?quà|doi.?qua)", re.I)
PROMO_PATH_RE = re.compile(r"(khuyen|uu-dai|uudai|voucher|coupon|promo|offer|deal|sale|reward|loyalty)", re.I)


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_json(path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def canonical_url(raw):
    try:
        p = urlsplit(raw.strip())
        if p.scheme not in ("http", "https") or not p.hostname:
            return None
        host = p.hostname.lower().strip(".")
        if host.startswith("www."):
            host = host[4:]
        netloc = host
        if p.port and not ((p.scheme == "https" and p.port == 443) or (p.scheme == "http" and p.port == 80)):
            netloc = f"{host}:{p.port}"
        qs = []
        for k, v in parse_qsl(p.query, keep_blank_values=True):
            kl = k.lower()
            if kl.startswith("utm_") or kl in TRACKING:
                continue
            qs.append((k, v))
        path = re.sub(r"/{2,}", "/", p.path or "/")
        return urlunsplit((p.scheme, netloc, path, urlencode(qs), ""))
    except Exception:
        return None


def host_of(raw):
    try:
        h = (urlsplit(raw).hostname or "").lower().strip(".")
        return h[4:] if h.startswith("www.") else h
    except Exception:
        return ""


def registrable(host):
    host = (host or "").lower().strip(".")
    if host.startswith("www."):
        host = host[4:]
    parts = host.split(".")
    if len(parts) <= 2:
        return host
    if ".".join(parts[-2:]) in MULTI_SUFFIX and len(parts) >= 3:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def source_id(domain):
    return "SRCV1-" + hashlib.sha1(domain.encode("utf-8")).hexdigest()[:12].upper()


def vertical_for(text):
    text = text or ""
    if BANK_RE.search(text): return "BANK_CARD"
    if PAY_RE.search(text): return "PAYMENT_WALLET"
    if LOYALTY_RE.search(text): return "LOYALTY_REWARDS"
    if TRAVEL_RE.search(text): return "TRAVEL_MOBILITY"
    if FOOD_RE.search(text): return "FOOD_BEVERAGE"
    if RETAIL_RE.search(text): return "RETAIL_ECOMMERCE"
    return "GENERAL"


def worker_for(vertical, access_class):
    if access_class in {"AUTHORIZED_ACCOUNT", "RESIDENTIAL_REQUIRED", "MANUAL_ONLY"}:
        return "PROMO_L2"
    if vertical in {"BANK_CARD", "PAYMENT_WALLET", "TRAVEL_MOBILITY"}:
        return "PROMO_BANKS"
    if vertical in {"RETAIL_ECOMMERCE", "FOOD_BEVERAGE", "LOYALTY_REWARDS", "GENERAL"}:
        return "PROMO_RETAIL"
    return "PROMO_RETAIL"


def main():
    l2 = load_json(L2_STATE, {})
    access_by_url = {u: (v or {}).get("access_state") for u, v in (l2.get("seen") or {}).items()}
    groups = {}

    def add(url=None, domain=None, name=None, origin=None, via=None, extra=None):
        url = canonical_url(url) if url else None
        host = host_of(url) if url else (domain or "").lower().strip(".")
        if host.startswith("www."):
            host = host[4:]
        rd = registrable(host)
        if not rd or "." not in rd:
            return
        g = groups.setdefault(rd, {
            "source_id": source_id(rd), "registrable_domain": rd,
            "hostnames": set(), "entry_points": set(), "names": set(),
            "origins": set(), "discovery_methods": set(), "access_observations": defaultdict(int),
            "legacy_first_batch": None, "legacy_last_batch": None,
        })
        if host: g["hostnames"].add(host)
        if url:
            g["entry_points"].add(url)
            a = access_by_url.get(url)
            if a: g["access_observations"][a] += 1
        if name: g["names"].add(str(name).strip())
        if origin: g["origins"].add(origin)
        if via: g["discovery_methods"].add(via)
        extra = extra or {}
        fb, lb = extra.get("first_batch"), extra.get("last_batch")
        if isinstance(fb, int): g["legacy_first_batch"] = fb if g["legacy_first_batch"] is None else min(g["legacy_first_batch"], fb)
        if isinstance(lb, int): g["legacy_last_batch"] = lb if g["legacy_last_batch"] is None else max(g["legacy_last_batch"], lb)

    if DOMAINS.exists():
        for d in DOMAINS.read_text(errors="replace").splitlines():
            d = d.strip()
            if d:
                add(url=f"https://{d}/", domain=d, origin="SOURCE_HUNTER_MASTER", via="master_domain")

    if EVIDENCE.exists():
        for line in EVIDENCE.read_text(errors="replace").splitlines():
            try:
                r = json.loads(line)
            except Exception:
                continue
            add(url=r.get("url"), domain=r.get("domain"), origin="SOURCE_HUNTER_EVIDENCE", via=r.get("via"))

    for path, origin in ((PROMO_EXPORT, "PROMO_CANONICAL_EXPORT"), (LEGACY_SEED, "PROMO_LEGACY_SEED")):
        if not path.exists():
            continue
        for line in path.read_text(errors="replace").splitlines():
            try:
                r = json.loads(line)
            except Exception:
                continue
            url = r.get("source_url") or r.get("canonical_url") or r.get("url")
            domain = r.get("registrable_domain") or r.get("official_domain") or r.get("domain")
            if domain and "/" in domain and not domain.startswith("http"):
                domain = domain.split("/", 1)[0]
            add(url=url, domain=domain, name=r.get("source_brand") or r.get("brand") or r.get("name"), origin=origin, via=r.get("via") or r.get("source_type"), extra=r)

    records = []
    dispatch = []
    counts = defaultdict(int)
    for rd, g in groups.items():
        eps = sorted(g["entry_points"], key=lambda u: (0 if PROMO_PATH_RE.search(urlsplit(u).path) else 1, len(u), u))
        text = " ".join([rd, " ".join(g["names"]), " ".join(eps[:8])])
        vertical = vertical_for(text)
        obs = g["access_observations"]
        if obs.get("LOGIN_REQUIRED"):
            access = "AUTHORIZED_ACCOUNT"
        elif obs.get("BLOCKED_DATACENTER"):
            access = "RESIDENTIAL_REQUIRED"
        elif obs.get("JS_BROWSER"):
            access = "JS_BROWSER"
        else:
            access = "PUBLIC_HTTP"
        radar = bool(RADAR_RE.search(rd))
        promo_ep = sum(1 for u in eps if PROMO_PATH_RE.search(urlsplit(u).path))
        priority = 50 + min(25, promo_ep * 5) + (10 if "PROMO_CANONICAL_EXPORT" in g["origins"] else 0) - (20 if radar else 0)
        priority = max(1, min(100, priority))
        source_type = "DISCOVERY_NODE" if radar else "DIRECT_SOURCE_CANDIDATE"
        worker = worker_for(vertical, access)
        rec = {
            "schema": "promo.master_input_source.v1",
            "source_id": g["source_id"],
            "registrable_domain": rd,
            "hostnames": sorted(g["hostnames"]),
            "canonical_root_url": f"https://{rd}/",
            "entry_points": eps[:40],
            "representative_names": sorted(g["names"])[:12],
            "source_type": source_type,
            "vertical": vertical,
            "access_class": access,
            "crawl_priority": priority,
            "origins": sorted(g["origins"]),
            "discovery_methods": sorted(g["discovery_methods"]),
            "legacy_first_batch": g["legacy_first_batch"],
            "legacy_last_batch": g["legacy_last_batch"],
            "status": "ACTIVE_INPUT",
            "writer": "PROMO-SRC-HUNTER-V1",
        }
        records.append(rec)
        dispatch.append({
            "schema": "promo.dispatch.v1", "source_id": g["source_id"],
            "registrable_domain": rd, "vertical": vertical, "access_class": access,
            "assigned_lane": worker, "priority": priority, "status": "ELIGIBLE",
        })
        counts[vertical] += 1
        counts[access] += 1
        counts[worker] += 1

    records.sort(key=lambda r: (-r["crawl_priority"], r["registrable_domain"]))
    dispatch.sort(key=lambda r: (-r["priority"], r["registrable_domain"]))
    OUT.write_text("".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in records), encoding="utf-8")
    DISPATCH.write_text("".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in dispatch), encoding="utf-8")
    status = {
        "schema": "promo.master_input_status.v1", "generated_at": now(),
        "project_id": "PROMO-SRC-HUNTER-V1", "record_count": len(records),
        "source_hunter_domains": sum(1 for _ in DOMAINS.read_text(errors="replace").splitlines() if _.strip()) if DOMAINS.exists() else 0,
        "promo_export_present": PROMO_EXPORT.exists(), "legacy_seed_present": LEGACY_SEED.exists(),
        "counts": dict(sorted(counts.items())),
        "dedupe_key": "registrable_domain", "url_key": "canonical_url",
        "production_write": False, "mode": "BRIDGE_SHADOW",
    }
    STATUS.write_text(json.dumps(status, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(status, ensure_ascii=False))


if __name__ == "__main__":
    main()
