#!/usr/bin/env python3
import json
import ssl
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATE = ROOT / "state.json"
DOMAINS = ROOT / "master_domains.txt"
SEEN = ROOT / "seen_urls.txt"
UA = "SourceScanFree/1.0 (Vietnam promo source discovery; GitHub Actions)"
CTX = ssl.create_default_context()
PATTERNS = ["*.vn/", "*.com/vn/*", "*.com/vi-vn/*", "*.com/vietnam/*"]


def load_json(path, default):
    try: return json.loads(path.read_text())
    except Exception: return default


def load_lines(path):
    if not path.exists(): return []
    return [x.strip() for x in path.read_text(errors="replace").splitlines() if x.strip()]


def save_lines(path, vals):
    path.write_text("\n".join(sorted(set(vals))) + ("\n" if vals else ""))


def host_of(raw):
    try:
        h=(urllib.parse.urlsplit(raw).hostname or "").lower().strip(".")
        return h[4:] if h.startswith("www.") else h
    except Exception: return ""


def valid_domain(d):
    if not d or "." not in d or len(d)>253: return False
    bad=("facebook.com","instagram.com","youtube.com","google.com","tiktok.com","x.com","twitter.com","linkedin.com")
    return not any(d==x or d.endswith("."+x) for x in bad)


def query(index_id, pattern, page):
    params={
        "url":pattern,
        "output":"json",
        "filter":"status:200",
        "page":str(page),
        "pageSize":"1",
        "limit":"800",
    }
    url=f"https://index.commoncrawl.org/{urllib.parse.quote(index_id)}-index?{urllib.parse.urlencode(params)}"
    req=urllib.request.Request(url,headers={"User-Agent":UA,"Accept":"application/x-ndjson,text/plain,*/*"})
    try:
        with urllib.request.urlopen(req,timeout=45,context=CTX) as r:
            text=r.read(5000000).decode("utf-8",errors="replace")
    except urllib.error.HTTPError as e:
        if e.code==400 and page>0:
            return query(index_id,pattern,0), True
        if e.code in (429,503): return [], False
        raise
    rows=[]
    for line in text.splitlines():
        try:
            obj=json.loads(line)
            u=obj.get("url") or ""
            if u: rows.append(u)
        except Exception: pass
    return rows, False


def main():
    s=load_json(STATE,{"version":1,"run_count":0,"frontier":[],"history":[]})
    index=s.get("cc_index") or "CC-MAIN-2026-25"
    domains=set(load_lines(DOMAINS))
    seen=set(load_lines(SEEN))
    frontier=list(s.get("frontier") or [])
    pattern_i=int(s.get("cc_domain_pattern_cursor",0))%len(PATTERNS)
    page=int(s.get("cc_domain_page",0))
    pattern=PATTERNS[pattern_i]
    try:
        result=query(index,pattern,page)
        if isinstance(result,tuple) and len(result)==2 and isinstance(result[0],tuple):
            (urls,_), reset=result
        else:
            urls,reset=result
    except Exception as e:
        s["cc_domain_last_error"]=type(e).__name__+":"+str(e)[:120]
        STATE.write_text(json.dumps(s,ensure_ascii=False,indent=2,sort_keys=True)+"\n")
        print(json.dumps({"ok":False,"pattern":pattern,"page":page,"error":s["cc_domain_last_error"]}))
        return

    before=len(domains)
    candidates=[]
    for u in urls:
        d=host_of(u)
        if not valid_domain(d): continue
        path=urllib.parse.urlsplit(u).path.lower()
        relevant=d.endswith(".vn") or path.startswith("/vn/") or path=="/vn" or path.startswith("/vi-vn/") or path=="/vi-vn" or path.startswith("/vietnam/")
        if not relevant: continue
        if d not in domains:
            domains.add(d)
            candidates.append(d)

    added_tasks=0
    for d in candidates[:350]:
        for u in (f"https://{d}/",f"https://{d}/sitemap.xml",f"https://{d}/khuyen-mai",f"https://{d}/uu-dai"):
            if len(frontier)>=40000: break
            if u in seen: continue
            seen.add(u)
            frontier.append({"url":u,"via":"common_crawl_domain","seed":True})
            added_tasks+=1

    s["frontier"]=frontier[:40000]
    s["cc_domain_last_pattern"]=pattern
    s["cc_domain_last_page"]=page
    s["cc_domain_last_rows"]=len(urls)
    s["cc_domain_last_new_domains"]=len(domains)-before
    if reset:
        page=0
    page+=1
    if page>=200:
        page=0
        pattern_i=(pattern_i+1)%len(PATTERNS)
    s["cc_domain_page"]=page
    s["cc_domain_pattern_cursor"]=pattern_i
    STATE.write_text(json.dumps(s,ensure_ascii=False,indent=2,sort_keys=True)+"\n")
    save_lines(DOMAINS,domains)
    save_lines(SEEN,seen)
    print(json.dumps({
        "ok":True,"index":index,"pattern":pattern,"page":s["cc_domain_last_page"],
        "rows":len(urls),"new_domains":len(domains)-before,"added_tasks":added_tasks,
        "master_domains":len(domains),"frontier":len(frontier)
    },ensure_ascii=False))

if __name__=="__main__": main()
