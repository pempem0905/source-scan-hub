#!/usr/bin/env python3
import json
import os
import re
import ssl
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
STATE = ROOT / "state.json"
DOMAINS = ROOT / "master_domains.txt"
SEEN = ROOT / "seen_urls.txt"
CATALOG = REPO / "integration" / "consumer_coverage_catalog.json"
ENV = REPO / ".env"
UA = "SourceScanFree/1.1 (Vietnam promo source discovery; GitHub Actions)"
CTX = ssl.create_default_context()


def load_json(path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def lines(path):
    if not path.exists():
        return []
    return [x.strip() for x in path.read_text(errors="replace").splitlines() if x.strip()]


def save_lines(path, vals):
    path.write_text("\n".join(sorted(set(vals))) + ("\n" if vals else ""))


def read_env():
    out = {}
    if not ENV.exists():
        return out
    for raw in ENV.read_text(errors="replace").splitlines():
        m = re.match(r"^([A-Z0-9_]+)=(.*)$", raw.strip())
        if not m:
            continue
        out[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return out


def latest_cc():
    req = urllib.request.Request("https://index.commoncrawl.org/collinfo.json", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=25, context=CTX) as r:
        data = json.loads(r.read().decode("utf-8"))
    return data[0].get("id") if data else None


def normalize_domain(v):
    v = (v or "").strip().lower()
    if not v:
        return ""
    if "://" in v:
        try:
            v = urllib.parse.urlsplit(v).hostname or ""
        except Exception:
            return ""
    v = v.strip(".")
    if v.startswith("www."):
        v = v[4:]
    if not v or "." not in v or len(v) > 253:
        return ""
    return v


def coverage_catalog_domains():
    data = load_json(CATALOG, {"categories": []})
    out = []
    for category in data.get("categories") or []:
        for target in category.get("targets") or []:
            for raw in target.get("domains") or []:
                d = normalize_domain(raw)
                if d and d not in out:
                    out.append(d)
    return out


def import_legacy_domains():
    env = read_env()
    base = env.get("SUPABASE_URL") or env.get("VITE_SUPABASE_URL")
    key = env.get("SUPABASE_PUBLISHABLE_KEY") or env.get("VITE_SUPABASE_PUBLISHABLE_KEY")
    if not base or not key:
        return set(), "env_missing"
    found = set()
    for offset in range(0, 100000, 1000):
        url = f"{base.rstrip('/')}/rest/v1/sources?select=domain,canonical_domain&limit=1000&offset={offset}"
        req = urllib.request.Request(url, headers={"apikey": key, "Authorization": f"Bearer {key}", "User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
                rows = json.loads(r.read().decode("utf-8"))
        except Exception as e:
            return found, f"read_failed:{type(e).__name__}"
        if not isinstance(rows, list):
            return found, "unexpected_payload"
        for row in rows:
            d = normalize_domain(row.get("canonical_domain") or row.get("domain"))
            if d:
                found.add(d)
        if len(rows) < 1000:
            return found, "ok"
    return found, "capped"


def main():
    state = load_json(STATE, {"version": 1, "run_count": 0, "cc_pattern_cursor": 0, "frontier": [], "history": []})
    domains = set(lines(DOMAINS))
    seen = set(lines(SEEN))
    frontier = list(state.get("frontier") or [])
    max_frontier = 40000

    # Catalog thực dụng được seed trước long-tail discovery.
    catalog = coverage_catalog_domains()
    before_catalog = len(domains)
    domains.update(catalog)
    catalog_domain_added = len(domains) - before_catalog
    catalog_seed_added = 0
    promo = ["khuyen-mai", "uu-dai", "voucher", "promotion"]
    for d in catalog:
        root = f"https://{d}/"
        candidates = [root, root + "sitemap.xml"] + [root + p for p in promo]
        for u in candidates:
            if len(frontier) >= max_frontier:
                break
            if u in seen:
                continue
            seen.add(u)
            frontier.append({"url": u, "via": "coverage_catalog", "seed": True})
            catalog_seed_added += 1

    try:
        cc = latest_cc()
        if cc:
            state["cc_index"] = cc
    except Exception as e:
        state["cc_bootstrap_error"] = type(e).__name__

    if not state.get("legacy_import_complete"):
        imported, status = import_legacy_domains()
        before = len(domains)
        domains.update(imported)
        state["legacy_import_status"] = status
        state["legacy_imported_domains"] = len(imported)
        if status in {"ok", "capped"}:
            state["legacy_import_complete"] = True
        state["legacy_import_new_domains"] = len(domains) - before

    ordered = sorted(domains)
    cursor = int(state.get("legacy_seed_cursor", 0))
    added = 0
    batch_domains = ordered[cursor:cursor + 220]
    for d in batch_domains:
        root = f"https://{d}/"
        candidates = [root, root + "sitemap.xml"] + [root + p for p in promo]
        for u in candidates:
            if len(frontier) >= max_frontier:
                break
            if u in seen:
                continue
            seen.add(u)
            frontier.append({"url": u, "via": "legacy_migration", "seed": True})
            added += 1
    if ordered:
        state["legacy_seed_cursor"] = (cursor + len(batch_domains)) % len(ordered)

    state["coverage_catalog_domains"] = len(catalog)
    state["coverage_catalog_new_domains"] = catalog_domain_added
    state["coverage_catalog_seed_added_this_run"] = catalog_seed_added
    state["legacy_seed_added_this_run"] = added
    state["frontier"] = frontier[:max_frontier]
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    save_lines(SEEN, seen)
    save_lines(DOMAINS, domains)
    print(json.dumps({
        "cc_index": state.get("cc_index"),
        "legacy_import_status": state.get("legacy_import_status"),
        "legacy_imported_domains": state.get("legacy_imported_domains", 0),
        "coverage_catalog_domains": len(catalog),
        "coverage_catalog_new_domains": catalog_domain_added,
        "coverage_catalog_seed_added": catalog_seed_added,
        "master_domains": len(domains),
        "legacy_seed_added": added,
        "frontier": len(frontier),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
