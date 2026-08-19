#!/usr/bin/env python3
import hashlib, json, os, re, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path
from datetime import datetime, timezone

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'integration'/'masoffer_handoff_v1.jsonl'
STATUS=ROOT/'integration'/'masoffer_v2_status.json'
SAFE_SUFFIXES=('masoffer.net','masoffer.com')
UA='PROMO-MASTER-MasOffer/2.1'
DEFAULT_ENDPOINTS=[
 'https://publisher-api.masoffer.net/offer/all',
 'https://publisher-api.masoffer.net/v1/promotions',
 'https://publisher-api.masoffer.net/offer/pushsale',
 'https://publisher-api.masoffer.net/offer/brand',
]
LIST_KEYS=('data','items','results','offers','promotions','campaigns','products','vouchers','coupons','rows','list','result')

def now(): return datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
def safe(url):
    try:
        p=urllib.parse.urlsplit(url); h=(p.hostname or '').lower().strip('.')
        return p.scheme=='https' and any(h==s or h.endswith('.'+s) for s in SAFE_SUFFIXES)
    except Exception: return False

def endpoints():
    raw=(os.getenv('MASOFFER_API_URLS') or '').strip()
    vals=[x.strip() for x in re.split(r'[\n,;]+',raw) if x.strip()] if raw else DEFAULT_ENDPOINTS
    return [x for x in vals if safe(x)][:30]

def credentials():
    pid=(os.getenv('MASOFFER_PUBLISHER_ID') or '').strip()
    pkey=(os.getenv('MASOFFER_PUBLISHER_KEY') or '').strip()
    token=(os.getenv('MASOFFER_API_TOKEN') or '').strip()
    legacy=(os.getenv('MASOFFER_PUBLISHER_TOKEN') or '').strip()
    toks=[]
    for v in (token, legacy):
        if v and v not in toks: toks.append(v)
        d=urllib.parse.unquote(v) if v else ''
        if d and d not in toks: toks.append(d)
    return pid,pkey,toks

def extract(payload, depth=0):
    if depth>5: return []
    if isinstance(payload,list): return [x for x in payload if isinstance(x,dict)]
    if not isinstance(payload,dict): return []
    for k in LIST_KEYS:
        v=payload.get(k)
        if isinstance(v,list):
            rows=[x for x in v if isinstance(x,dict)]
            if rows: return rows
        if isinstance(v,dict):
            r=extract(v,depth+1)
            if r: return r
    for v in payload.values():
        if isinstance(v,(dict,list)):
            r=extract(v,depth+1)
            if r: return r
    return []

def auth_variants(pid,pkey,tokens):
    out=[]
    for token in tokens:
        raw=[
          {'Publisher-ID':pid,'Publisher-Key':pkey,'API-Token':token},
          {'publisher-id':pid,'publisher-key':pkey,'api-token':token},
          {'X-Publisher-ID':pid,'X-Publisher-Key':pkey,'X-API-Token':token},
          {'Publisher-ID':pid,'Publisher-Key':pkey,'Authorization':'Bearer '+token},
          {'publisher_id':pid,'publisher_key':pkey,'api_token':token},
        ]
        for h in raw:
            if h not in out: out.append(h)
    return out

def query_variants(pid,pkey,tokens):
    out=[{}]
    for token in tokens:
        for q in (
          {'publisher_id':pid,'publisher_key':pkey,'api_token':token},
          {'publisherId':pid,'publisherKey':pkey,'apiToken':token},
          {'pub_id':pid,'pub_key':pkey,'token':token},
          {'publisher':pid,'key':pkey,'token':token},
        ):
            if q not in out: out.append(q)
    return out

def request(url,headers,query):
    if query:
        sep='&' if urllib.parse.urlsplit(url).query else '?'
        url=url+sep+urllib.parse.urlencode(query)
    req=urllib.request.Request(url,method='GET',headers={'Accept':'application/json, */*;q=0.2','User-Agent':UA,**headers})
    with urllib.request.urlopen(req,timeout=18) as r:
        raw=r.read(8_000_000); ct=(r.headers.get('Content-Type') or '').lower(); text=raw.decode('utf-8',errors='replace').strip()
        if not text: return {},r.status
        if 'json' in ct or text[:1] in '[{': return json.loads(text),r.status
        raise ValueError('non_api_payload')

def normalize(item, endpoint):
    title=item.get('title') or item.get('name') or item.get('promotion_name') or item.get('offer_name') or item.get('product_name') or item.get('campaign_name') or 'MasOffer promotion'
    merchant=item.get('merchant_name') or item.get('merchant') or item.get('advertiser_name') or item.get('brand_name') or item.get('brand') or item.get('shop_name') or item.get('offer_name')
    if isinstance(merchant,dict): merchant=merchant.get('name') or merchant.get('title') or merchant.get('id')
    src=item.get('url') or item.get('link') or item.get('landing_url') or item.get('product_url') or item.get('destination_url') or item.get('url_web')
    aff=item.get('affiliate_url') or item.get('tracking_url') or item.get('tracking_link') or item.get('aff_link') or item.get('deeplink')
    code=item.get('code') or item.get('coupon_code') or item.get('voucher_code') or item.get('promo_code') or item.get('promotion_code')
    ident=str(item.get('id') or item.get('offer_id') or item.get('promotion_id') or item.get('product_id') or item.get('campaign_id') or '')
    stable='|'.join(str(x or '') for x in (ident,title,code,src,endpoint))
    return {'schema':'promo.candidate.v1','idempotency_key':'MO2|'+hashlib.sha1(stable.encode('utf-8')).hexdigest()[:24],'source_worker':'PROMO MasOffer Feed v2','source_url':src,'affiliate_url':aff,'affiliate_network':'MASOFFER','merchant':merchant or 'Unknown merchant','title':str(title)[:500],'benefit_type':'LITERAL_CODE_CANDIDATE' if code else 'PROMOTION_CANDIDATE','benefit_value':str(item.get('description') or item.get('content') or item.get('detail') or title)[:500],'literal_code':str(code).strip() if code else None,'status':'AFFILIATE_FEED_UNVERIFIED','verification_required':True,'production_write':False,'evidence':'MasOffer Publisher API discovery only; official merchant verification required before production commit.','evidence_checked_at':now(),'source_endpoint':urllib.parse.urlsplit(endpoint).path}

def main():
    pid,pkey,toks=credentials(); eps=endpoints()
    if not (pid and pkey and toks):
        st={'schema':'promo.masoffer_status.v2','generated_at':now(),'state':'CREDENTIALS_INCOMPLETE','publisher_id_present':bool(pid),'publisher_key_present':bool(pkey),'api_token_present':bool(toks),'endpoints_considered':len(eps),'candidate_rows':0}
        STATUS.write_text(json.dumps(st,ensure_ascii=False,indent=2)+'\n'); print(json.dumps(st)); return
    errors=[]; all_rows=[]; successes=[]
    hs=auth_variants(pid,pkey,toks); qs=query_variants(pid,pkey,toks)
    for ep in eps:
        endpoint_rows=[]; endpoint_success=None
        for hi,h in enumerate(hs):
            if endpoint_rows: break
            for qi,q in enumerate(qs):
                try:
                    payload,http=request(ep,h,q); batch=extract(payload)
                    if batch:
                        endpoint_rows=batch; endpoint_success={'endpoint':ep,'variant':f'h{hi+1}/q{qi+1}','http_status':http,'raw_rows':len(batch)}; break
                    errors.append(f'empty:{urllib.parse.urlsplit(ep).path}')
                except urllib.error.HTTPError as e:
                    errors.append(f'HTTP_{e.code}:{urllib.parse.urlsplit(ep).path}')
                    if e.code==429: time.sleep(1)
                except Exception as e:
                    errors.append(f'{type(e).__name__}:{urllib.parse.urlsplit(ep).path}')
        if endpoint_rows:
            successes.append(endpoint_success)
            all_rows.extend(normalize(x,ep) for x in endpoint_rows[:5000] if isinstance(x,dict))
    unique={}
    for row in all_rows: unique[row['idempotency_key']]=row
    normalized=sorted(unique.values(),key=lambda x:(str(x.get('merchant') or ''),str(x.get('title') or ''),x['idempotency_key']))
    OUT.write_text(''.join(json.dumps(x,ensure_ascii=False,sort_keys=True)+'\n' for x in normalized),encoding='utf-8')
    st={'schema':'promo.masoffer_status.v2','generated_at':now(),'state':'OK' if normalized else 'API_NOT_RESOLVED','credentials_complete':True,'publisher_id_present':True,'publisher_key_present':True,'api_token_present':True,'endpoints_considered':len(eps),'auth_variants':len(hs),'query_variants':len(qs),'successful_endpoints':successes,'candidate_rows':len(normalized),'last_error':errors[-1] if errors else None,'error_tail':errors[-8:]}
    STATUS.write_text(json.dumps(st,ensure_ascii=False,indent=2,sort_keys=True)+'\n',encoding='utf-8'); print(json.dumps(st,ensure_ascii=False))
if __name__=='__main__': main()
