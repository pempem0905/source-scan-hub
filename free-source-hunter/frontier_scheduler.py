#!/usr/bin/env python3
import json
import os
from collections import defaultdict, deque
from pathlib import Path
from urllib.parse import urlsplit

ROOT=Path(__file__).resolve().parent
STATE=ROOT/'state.json'
STATUS=ROOT/'status.json'
BASE_PER_HOST=int(os.getenv('FREE_HUNTER_PER_HOST_BATCH','16'))
MAX_ACTIVE=int(os.getenv('FREE_HUNTER_ACTIVE_FRONTIER','1800'))
MAX_TOTAL=40000
PRIORITY={
    'new_domain_promo':0,'seed_promo_path':0,'internal_promo':1,'external_promo':1,
    'common_crawl':2,'radar_out':3,'curated_seed':3,'new_domain_root':4,
    'seed_sitemap':5,'new_domain_sitemap':5,'sitemap':6,'frontier':7,
}

def host(url):
    try:return (urlsplit(url).hostname or '').lower().removeprefix('www.')
    except Exception:return ''

def read_json(path,default):
    try:return json.loads(path.read_text())
    except Exception:return default

def main():
    s=read_json(STATE,{})
    if not s:return
    st=read_json(STATUS,{})
    prev429=float(((st.get('last_run') or {}).get('rate429') or 0))
    if prev429>=25:
        per_host=max(2,min(BASE_PER_HOST,4))
        pressure='HIGH'
    elif prev429>=10:
        per_host=max(4,min(BASE_PER_HOST,8))
        pressure='MEDIUM'
    else:
        per_host=BASE_PER_HOST
        pressure='LOW'

    all_tasks=[]
    all_tasks.extend(s.get('frontier') or [])
    all_tasks.extend(s.get('frontier_deferred') or [])
    uniq={}
    for t in all_tasks:
        u=t.get('url') if isinstance(t,dict) else None
        if u and u not in uniq:uniq[u]=t

    buckets=defaultdict(list)
    for t in uniq.values():buckets[host(t.get('url',''))].append(t)
    for h in buckets:
        buckets[h].sort(key=lambda t:(PRIORITY.get(t.get('via','frontier'),8),len(t.get('url','')),t.get('url','')))
    hosts=sorted(buckets,key=lambda h:(PRIORITY.get(buckets[h][0].get('via','frontier'),8),-len(buckets[h]),h))

    # Strict per-host quota, then interleave hosts one URL at a time. This prevents
    # an 8-worker pool from hitting the same domain 8 times at once.
    active_queues={}
    deferred=[]
    for h in hosts:
        b=buckets[h]
        active_queues[h]=deque(b[:per_host])
        deferred.extend(b[per_host:])

    active=[]
    live=[h for h in hosts if active_queues[h]]
    while live and len(active)<MAX_ACTIVE:
        nxt=[]
        for h in live:
            if len(active)>=MAX_ACTIVE:break
            if active_queues[h]:active.append(active_queues[h].popleft())
            if active_queues[h]:nxt.append(h)
        live=nxt

    # If MAX_ACTIVE truncates the round-robin set, preserve every unconsumed task.
    for q in active_queues.values():
        while q:deferred.append(q.popleft())

    s['frontier']=active[:MAX_ACTIVE]
    s['frontier_deferred']=deferred[:max(0,MAX_TOTAL-len(active))]
    s['frontier_scheduler']={
        'active':len(s['frontier']),
        'deferred':len(s['frontier_deferred']),
        'unique_hosts':len([h for h in buckets if h]),
        'base_per_host_batch':BASE_PER_HOST,
        'effective_per_host_batch':per_host,
        'previous_429_rate':prev429,
        'rate_limit_pressure':pressure,
        'strategy':'strict_host_quota_round_robin',
        'max_active':MAX_ACTIVE,
    }
    STATE.write_text(json.dumps(s,ensure_ascii=False,indent=2,sort_keys=True)+'\n')
    print(json.dumps(s['frontier_scheduler'],ensure_ascii=False))

if __name__=='__main__':main()
