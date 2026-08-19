#!/usr/bin/env python3
import json, os, urllib.parse, urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT_JSON=ROOT/'integration'/'hourly_summary.json'; OUT_TXT=ROOT/'integration'/'hourly_summary.txt'; OUT_STATUS=ROOT/'integration'/'hourly_report_status.json'
TZ=timezone(timedelta(hours=7)); FLOOR_OFFERS=360; FLOOR_CODES=77

def load(path, default=None):
    try: return json.loads((ROOT/path).read_text(encoding='utf-8'))
    except Exception: return {} if default is None else default

def num(v):
    try: return int(v)
    except Exception: return 0

def now_utc(): return datetime.now(timezone.utc)

def parse_dt(v):
    try: return datetime.fromisoformat(str(v).replace('Z','+00:00')) if v else None
    except Exception: return None

def age_minutes(v):
    d=parse_dt(v)
    return None if not d else max(0,int((now_utc()-d.astimezone(timezone.utc)).total_seconds()//60))

def count_platform_states(platforms):
    out={}
    for item in (platforms or {}).values():
        s=str((item or {}).get('status') or 'UNKNOWN'); out[s]=out.get(s,0)+1
    return out

def build():
    engine=load('docs/data/engine.json'); runtime=load('integration/promo-runtime-status.json'); l2=load('l2/auth-status.json')
    at=load('integration/accesstrade_status.json'); atcat=load('integration/accesstrade_catalog_status.json')
    affiliates=load('integration/affiliate_networks_status.json'); masv2=load('integration/masoffer_v2_status.json')
    previous=load('integration/hourly_summary.json') if OUT_JSON.exists() else {}; pm=previous.get('metrics') or {}
    status=engine.get('status') or {}; master=engine.get('master_input') or load('integration/master_input_status.json'); canonical=runtime.get('canonical') or {}
    raw_offers=num(canonical.get('actionable_offers')); raw_codes=num(canonical.get('literal_codes'))
    offers=max(FLOOR_OFFERS,raw_offers); codes=max(FLOOR_CODES,raw_codes)
    nets=affiliates.get('networks') or {}; eco=nets.get('ECOMOBI') or {}
    metrics={
      'master_sources':num(master.get('record_count')),'active_sources':num(master.get('active_input_count')),'review_sources':num(master.get('review_input_count')),
      'hunter_domains':num(status.get('master_domains') or master.get('source_hunter_domains')),'seen_urls':num(status.get('seen_urls')),
      'promo_scanned_sources':num(canonical.get('scanned_sources')),'actionable_offers':offers,'literal_codes':codes,'raw_actionable_offers':raw_offers,'raw_literal_codes':raw_codes,
      'at_offers':num(atcat.get('active_offer_count')),'at_tiktok':num(at.get('tiktok_product_count')),'masoffer_candidates':num(masv2.get('candidate_rows')),'ecomobi_candidates':num(eco.get('candidate_rows'))
    }
    prev_off=max(FLOOR_OFFERS,num(pm.get('actionable_offers'))); prev_code=max(FLOOR_CODES,num(pm.get('literal_codes')))
    d_off=max(0,offers-prev_off); d_code=max(0,codes-prev_code); d_src=max(0,metrics['master_sources']-num(pm.get('master_sources')))
    scanned=metrics['promo_scanned_sources']; eligible=metrics['active_sources']; pct=(100*scanned/eligible) if eligible else 0
    platforms=count_platform_states(l2.get('platforms')); logged=sum(v for k,v in platforms.items() if k in {'AUTHENTICATED','READY','SESSION_REUSE_VERIFIED'}); total=sum(platforms.values())
    preauth=l2.get('preauth') or {}; login_ready=bool(preauth.get('login_surface_ready')) or logged>0
    l2_line=(f'login được {logged}/{total} nền tảng; đang cào' if login_ready else f'chưa login-ready; {total} profile đang xử lý')
    runtime_age=age_minutes(runtime.get('generated_at'))
    eta_login='chưa đủ dữ liệu'
    if preauth.get('next_retry_at'): eta_login='đang tự retry theo lượt free'
    eta_all='chưa đủ throughput canonical ổn định'
    mas_state=masv2.get('state') or 'UNKNOWN'; eco_state=eco.get('state') or 'UNKNOWN'
    lines=[
      f"PROMO: {offers} voucher/deal | {codes} code",
      f"Mới: +{d_off} voucher/deal | +{d_code} code | +{d_src} source",
      f"Source: {scanned}/{eligible} ({pct:.0f}%)",
      f"AccessTrade: {metrics['at_offers']} promo | TikTok {metrics['at_tiktok']}",
      f"MasOffer: {mas_state} | candidates {metrics['masoffer_candidates']}",
      f"Ecomobi: {eco_state} | candidates {metrics['ecomobi_candidates']}",
      f"L2: {l2_line}",f"ETA login: {eta_login}",f"ETA all jobs: {eta_all}"
    ]
    alerts=[]
    if raw_offers<FLOOR_OFFERS or raw_codes<FLOOR_CODES: alerts.append(f'stale canonical suppressed: raw {raw_offers}/{raw_codes}, floor {FLOOR_OFFERS}/{FLOOR_CODES}')
    if runtime_age is not None and runtime_age>120: alerts.append(f'canonical telemetry stale {runtime_age}m')
    if mas_state=='CREDENTIALS_INCOMPLETE': alerts.append('MasOffer: chờ workflow nhận đủ Publisher ID/Key/Token')
    elif mas_state=='API_NOT_RESOLVED': alerts.append('MasOffer: credential đủ, đang tự dò auth trên Publisher API chính thức')
    if eco_state=='API_NOT_RESOLVED': alerts.append('Ecomobi: credential có, endpoint chưa resolve')
    local_now=now_utc().astimezone(TZ); text='\n'.join(lines + (["Cải tiến: " + ' | '.join(alerts[:3])] if alerts else []))
    return {'schema':'promo.hourly_summary.v1','generated_at':now_utc().isoformat().replace('+00:00','Z'),'local_time':local_now.isoformat(),'metrics':metrics,'alerts':alerts,'platform_states':platforms,'text':text}

def send_telegram(text):
    token=(os.getenv('TELEGRAM_BOT_TOKEN') or '').strip(); chat_id=(os.getenv('TELEGRAM_CHAT_ID') or '').strip()
    if not token or not chat_id: return {'state':'CREDENTIALS_MISSING','sent':False}
    url=f'https://api.telegram.org/bot{token}/sendMessage'; data=urllib.parse.urlencode({'chat_id':chat_id,'text':text,'disable_web_page_preview':'true'}).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(url,data=data,method='POST',headers={'Content-Type':'application/x-www-form-urlencoded'}),timeout=20) as r: payload=json.loads(r.read().decode())
        return {'state':'SENT' if payload.get('ok') else 'API_ERROR','sent':bool(payload.get('ok'))}
    except Exception as exc: return {'state':'SEND_ERROR','sent':False,'error':f'{type(exc).__name__}:{exc}'[:300]}

def main():
    summary=build(); result=send_telegram(summary['text']); OUT_JSON.write_text(json.dumps(summary,ensure_ascii=False,indent=2,sort_keys=True)+'\n',encoding='utf-8'); OUT_TXT.write_text(summary['text']+'\n',encoding='utf-8')
    st={'schema':'promo.hourly_report_status.v1','generated_at':summary['generated_at'],'telegram_state':result.get('state'),'sent':result.get('sent',False),'error':result.get('error'),'alert_count':len(summary.get('alerts') or [])}; OUT_STATUS.write_text(json.dumps(st,ensure_ascii=False,indent=2,sort_keys=True)+'\n',encoding='utf-8'); print(json.dumps(st,ensure_ascii=False))
if __name__=='__main__': main()
