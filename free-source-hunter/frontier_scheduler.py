#!/usr/bin/env python3
import json
import os
from collections import defaultdict, deque
from pathlib import Path
from urllib.parse import urlsplit

ROOT=Path(__file__).resolve().parent
STATE=ROOT/'state.json'
PER_HOST=int(os.getenv('FREE_HUNTER_PER_HOST_BATCH','16'))
MAX_ACTIVE=int(os.getenv('FREE_HUNTER_ACTIVE_FRONTIER','1800'))
MAX_TOTAL=40000
PRIORITY={
    'new_domain_promo':0,'seed_promo_path':0,'internal_promo':1,'external_promo':1,
    'common_crawl':2,'radar_out':3,'curated_seed':3,'new_domain_root':4,
    'seed_sitemap':5,'new_domain_sitemap':5,'sitemap':6,'frontier':7,
}

def host(url):
    try: return (urlsplit(url).hostname or '').lower().removeprefix('www.')
    except Exception: return ''

def main():
    try: s=json.loads(STATE.read_text())
    except Exception: return
    all_tasks=[]
    all_tasks.extend(s.get('frontier') or [])
    all_tasks.extend(s.get('frontier_deferred') or [])
    uniq={}
    for t in all_tasks:
        u=t.get('url') if isinstance(t,dict) else None
        if u and u not in uniq: uniq[u]=t
    buckets=defaultdict(list)
    for t in uniq.values(): buckets[host(t.get('url',''))].append(t)
    for h in buckets:
        buckets[h].sort(key=lambda t:(PRIORITY.get(t.get('via','frontier'),8), len(t.get('url','')), t.get('url','')))
    hosts=sorted(buckets, key=lambda h:(PRIORITY.get(buckets[h][0].get('via','frontier'),8), -len(buckets[h]), h))
    active=[]; deferred=[]
    for idx,h in enumerate(hosts):
        b=buckets[h]
        take=min(PER_HOST,len(b),max(0,MAX_ACTIVE-len(active)))
        active.extend(b[:take]); deferred.extend(b[take:])
        if len(active)>=MAX_ACTIVE:
            for hh in hosts[idx+1:]: deferred.extend(buckets[hh])
            break
    if len(active)<MAX_ACTIVE and deferred:
        db=defaultdict(deque)
        for t in deferred: db[host(t.get('url',''))].append(t)
        deferred=[]
        dh=list(db)
        while dh and len(active)<MAX_ACTIVE:
            nxt=[]
            for h in dh:
                if db[h] and len(active)<MAX_ACTIVE:
                    active.append(db[h].popleft())
                if db[h]: nxt.append(h)
            dh=nxt
        for q in db.values():
            while q: deferred.append(q.popleft())
    s['frontier']=active[:MAX_ACTIVE]
    s['frontier_deferred']=deferred[:max(0,MAX_TOTAL-len(active))]
    s['frontier_scheduler']={
        'active':len(s['frontier']),'deferred':len(s['frontier_deferred']),
        'unique_hosts':len([h for h in buckets if h]),'per_host_batch':PER_HOST,
        'max_active':MAX_ACTIVE,
    }
    STATE.write_text(json.dumps(s,ensure_ascii=False,indent=2,sort_keys=True)+'\n')
    print(json.dumps(s['frontier_scheduler'],ensure_ascii=False))

if __name__=='__main__': main()
