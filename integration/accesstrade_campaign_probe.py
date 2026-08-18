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
    for _ in range(50):
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

def request(ts, params):
    url=BASE+'/v1/campaigns?'+urllib.parse.urlencode(params)
    last=None
    for idx,t in enumerate(ts):
        req=urllib.request.Request(url,headers={'Authorization':'Token '+t,'Accept':'application/json','User-Agent':'PROMO-MASTER-Campaign-Probe/1.0'})
        try:
            with urllib.request.urlopen(req,timeout=18) as r:
                return json.loads(r.read().decode('utf-8')),idx
        except urllib.error.HTTPError as e:
            last=f'HTTP_{e.code}'
            if e.code in (401,403): continue
            if e.code==429: time.sleep(2); continue
            raise
        except Exception as e: last=type(e).__name__
    raise RuntimeError(last or 'all_tokens_failed')

def fetch(ts, approval):
    out=[]; errors=[]; used=set()
    for page in range(1,21):
        params={'page':page,'limit':100}
        if approval: params['approval']=approval
        try:
            p,idx=request(ts,params); used.add(idx); batch=extract(p); out.extend(batch)
            if not batch or len(batch)<100: break
        except Exception as e:
            errors.append(f'{approval or "all"}:page_{page}:{type(e).__name__}:{e}'); break
    return out,errors,used

def norm(x):
    cid=str(x.get('id') or x.get('campaign_id') or '').strip()
    if not cid: return None
    merchant=x.get('merchant')
    if isinstance(merchant,dict): merchant=merchant.get('name') or merchant.get('display_name') or merchant.get('login_name')
    return {'campaign_id':cid,'name':x.get('name'),'merchant':merchant,'approval':str(x.get('approval') or '').lower(),'status':x.get('status'),'category':x.get('category'),'sub_category':x.get('sub_category'),'url':x.get('url'),'observed_at':now()}

def main():
    ts=tokens()
    if not ts: raise SystemExit('Missing AccessTrade tokens')
    approved,ea,ua=fetch(ts,'successful')
    pending,ep,up=fetch(ts,'pending')
    combined={}
    for raw in approved+pending:
        row=norm(raw)
        if row: combined[row['campaign_id']]=row
    rows=list(combined.values())
    counts=Counter(r.get('approval') or 'unknown' for r in rows)
    cats=Counter(str(r.get('category')) for r in rows if r.get('category'))
    merchants=Counter(str(r.get('merchant')) for r in rows if r.get('merchant'))
    ROWS_OUT.write_text(''.join(json.dumps(x,ensure_ascii=False,sort_keys=True)+'\n' for x in rows),encoding='utf-8')
    status={'schema':'promo.accesstrade_campaign_registration_status.v1','generated_at':now(),'tokens_configured':len(ts),'token_slots_used':sorted(ua|up),'registered_campaign_count':len(rows),'approved_campaign_count':counts.get('successful',0),'pending_campaign_count':counts.get('pending',0),'approval_breakdown':dict(counts),'category_breakdown':dict(cats.most_common(12)),'top_merchants':dict(merchants.most_common(12)),'errors':(ea+ep)[-10:]}
    OUT.write_text(json.dumps(status,ensure_ascii=False,indent=2,sort_keys=True)+'\n',encoding='utf-8')
    print(json.dumps(status,ensure_ascii=False))

if __name__=='__main__': main()
