#!/usr/bin/env python3
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
MASTER=ROOT/'integration'/'master_input_sources_v1.jsonl'
OUT=ROOT/'l2'/'hard-access-queue.jsonl'
STATUS=ROOT/'l2'/'hard-access-status.json'
HARD={'AUTHORIZED_ACCOUNT','RESIDENTIAL_REQUIRED','MANUAL_ONLY'}


def main():
    rows=[]
    if MASTER.exists():
        for line in MASTER.read_text(errors='replace').splitlines():
            try:r=json.loads(line)
            except Exception:continue
            if r.get('status')!='ACTIVE_INPUT' or r.get('access_class') not in HARD:
                continue
            ac=r.get('access_class')
            if ac=='AUTHORIZED_ACCOUNT': state='INFRA_PENDING_ACCOUNT_PROFILE'
            elif ac=='RESIDENTIAL_REQUIRED': state='INFRA_PENDING_RESIDENTIAL'
            else: state='MANUAL_ONLY'
            rows.append({
                'schema':'promo.l2.hard_access.v1',
                'source_id':r.get('source_id'),
                'registrable_domain':r.get('registrable_domain'),
                'vertical':r.get('vertical'),
                'access_class':ac,
                'entry_points':(r.get('entry_points') or [])[:12],
                'priority':r.get('crawl_priority'),
                'state':state,
                'session_profile':None,
                'credential_storage':'local-runner-only' if ac=='AUTHORIZED_ACCOUNT' else None,
                'production_write':False,
            })
    rows.sort(key=lambda x:(-int(x.get('priority') or 0),x.get('registrable_domain') or ''))
    OUT.write_text(''.join(json.dumps(r,ensure_ascii=False,sort_keys=True)+'\n' for r in rows),encoding='utf-8')
    counts={}
    for r in rows:
        counts[r['access_class']]=counts.get(r['access_class'],0)+1
        counts[r['state']]=counts.get(r['state'],0)+1
    STATUS.write_text(json.dumps({
        'schema':'promo.l2.hard_access_status.v1','total':len(rows),'counts':dict(sorted(counts.items())),
        'runner_ready':False,'production_write':False,
        'note':'No login is requested until an authorized persistent/self-hosted runner profile exists.'
    },ensure_ascii=False,indent=2,sort_keys=True)+'\n',encoding='utf-8')
    print(json.dumps({'total':len(rows),'counts':counts},ensure_ascii=False))

if __name__=='__main__':main()
