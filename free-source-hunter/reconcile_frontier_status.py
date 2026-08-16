#!/usr/bin/env python3
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parent
STATE=ROOT/'state.json'; STATUS=ROOT/'status.json'

def load(p):
    try: return json.loads(p.read_text())
    except Exception: return {}

def main():
    s=load(STATE); st=load(STATUS)
    active=len(s.get('frontier') or [])
    deferred=len(s.get('frontier_deferred') or [])
    total=active+deferred
    s['frontier_active_pending']=active
    s['frontier_deferred_pending']=deferred
    s['frontier_pending_total']=total
    st['frontier_active_pending']=active
    st['frontier_deferred_pending']=deferred
    st['frontier_pending']=total
    if isinstance(st.get('last_run'),dict): st['last_run']['frontier_pending']=total
    STATE.write_text(json.dumps(s,ensure_ascii=False,indent=2,sort_keys=True)+'\n')
    STATUS.write_text(json.dumps(st,ensure_ascii=False,indent=2,sort_keys=True)+'\n')
    print(json.dumps({'active':active,'deferred':deferred,'total':total}))
if __name__=='__main__': main()
