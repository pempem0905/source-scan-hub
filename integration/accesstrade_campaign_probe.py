#!/usr/bin/env python3
import json, os, time, urllib.error, urllib.parse, urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'integration'/'accesstrade_campaign_registration_status.json'
ROWS_OUT=ROOT/'integration'/'accesstrade_registered_campaigns.jsonl'
BASE='https://api.accesstrade.vn'


def now(): return datetime.now(timezone.utc).isoformat().replace('+00:00','Z')

def tokens():
    out=[]
    for n in ('ACCESSTRADE_API_TOKEN','ACCESSTRADE_API_TOKEN_2'):
        v=(os.getenv(n) or '').strip()
        if v and v not in out: out.append(v)
    return out

def extract(payload):
    if isinstance(payload,list): return [x for x in payload if isinstance(x,dict)]
    if not isinstance(payload,dict): return []
    q=[payload]
    for _ in range(80):
        if not q: break
        v=q.pop(0)
        if isinstance(v,list):
            d=[x for x in v if isinstance(x,dict)]
            if d: return d
        elif isinstance(v,dict):
            for k in ('data','campaigns','items','results'):
                if k in v: q.insert(0,v[k])
            q.extend(x for k,x in v.items() if k not in ('data','campaigns','items','results'))
    return []

def request(token, params):
    url=BASE+'/v1/campaigns?'+urllib.parse.urlencode(params)
    req=urllib.request.Request(url,headers={'Authorization':'Token '+token,'Accept':'application/json','User-Agent':'PROMO-MASTER-Campaign-Probe/3.0'})
    with urllib.request.urlopen(req,timeout=18) as r:
        return json.loads(r.read().decode('utf-8'))

def fetch_all_one(token,slot):
    out=[]; errors=[]; ok=False
    for page in range(1,31):
        try:
            payload=request(token,{'page':page,'limit':100}); ok=True
            batch=extract(payload); out.extend(batch)
            if not batch or len(batch)<100: break
        except urllib.error.HTTPError as e:
            if e.code==429:
                time.sleep(2); continue
            errors.append(f'token{slot}:all:page_{page}:HTTP_{e.code}'); break
        except Exception as e:
            errors.append(f'token{slot}:all:page_{page}:{type(e).__name__}:{e}'); break
    return out,errors,ok

def approval_value(x):
    return str(x.get('approval') or x.get('approval_status') or x.get('publisher_status') or '').strip().lower()

def norm(x,slot):
    cid=str(x.get('id') or x.get('campaign_id') or '').strip()
    if not cid: return None
    merchant=x.get('merchant')
    if isinstance(merchant,dict): merchant=merchant.get('name') or merchant.get('display_name') or merchant.get('login_name')
    return {'campaign_id':cid,'token_slot':slot,'name':x.get('name') or x.get('campaign_name'),'merchant':merchant,'approval':approval_value(x),'status':x.get('status'),'category':x.get('category') or x.get('category_name'),'sub_category':x.get('sub_category'),'url':x.get('url'),'observed_at':now()}

def main():
    ts=tokens()
    if not ts: raise SystemExit('Missing AccessTrade tokens')
    combined={}; all_errors=[]; token_stats={}; used=[]
    for slot,token in enumerate(ts):
        raw,errors,ok=fetch_all_one(token,slot)
        all_errors.extend(errors)
        if ok: used.append(slot)
        normalized=[]
        for item in raw:
            row=norm(item,slot)
            if row: normalized.append(row)
        breakdown=Counter(r.get('approval') or 'unknown' for r in normalized)
        registered=[r for r in normalized if r.get('approval') in {'successful','pending','approved','registered','waiting','processing'}]
        approved=[r for r in normalized if r.get('approval') in {'successful','approved'}]
        pending=[r for r in normalized if r.get('approval') in {'pending','registered','waiting','processing'}]
        token_stats[str(slot)]={'api_ok':ok,'total_campaign_rows':len(normalized),'registered_rows':len(registered),'approved_rows':len(approved),'pending_rows':len(pending),'approval_breakdown':dict(breakdown)}
        for row in registered:
            combined[f"{slot}:{row['campaign_id']}"]=row
    rows=list(combined.values())
    counts=Counter(r.get('approval') or 'unknown' for r in rows)
    approved_count=sum(v for k,v in counts.items() if k in {'successful','approved'})
    pending_count=sum(v for k,v in counts.items() if k in {'pending','registered','waiting','processing'})
    cats=Counter(str(r.get('category')) for r in rows if r.get('category'))
    merchants=Counter(str(r.get('merchant')) for r in rows if r.get('merchant'))
    unique_campaigns=len({r['campaign_id'] for r in rows})
    ROWS_OUT.write_text(''.join(json.dumps(x,ensure_ascii=False,sort_keys=True)+'\n' for x in rows),encoding='utf-8')
    status={'schema':'promo.accesstrade_campaign_registration_status.v3','generated_at':now(),'tokens_configured':len(ts),'token_slots_used':used,'token_stats':token_stats,'registered_campaign_count':len(rows),'unique_campaign_count':unique_campaigns,'approved_campaign_count':approved_count,'pending_campaign_count':pending_count,'approval_breakdown':dict(counts),'category_breakdown':dict(cats.most_common(12)),'top_merchants':dict(merchants.most_common(12)),'errors':all_errors[-12:]}
    OUT.write_text(json.dumps(status,ensure_ascii=False,indent=2,sort_keys=True)+'\n',encoding='utf-8')
    print(json.dumps(status,ensure_ascii=False))

if __name__=='__main__': main()
