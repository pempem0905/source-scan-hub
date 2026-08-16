#!/usr/bin/env python3
import datetime as dt
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QUEUE = ROOT / "l2" / "candidate-queue.jsonl"
TODAY = dt.date.today()
MONTHS = {m.lower(): i for i, m in enumerate(["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"], 1)}
MONTHS.update({m.lower(): i for i, m in enumerate(["January","February","March","April","May","June","July","August","September","October","November","December"], 1)})
DMY_RE = re.compile(r"\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b")
ENG_RE = re.compile(r"\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b", re.I)
YEAR_RE = re.compile(r"\b(20\d{2})\b")
CURRENT_SIGNAL_RE = re.compile(r"(valid|validity|till|until|through|promotion period|thời gian|hiệu lực|áp dụng|den ngay|đến ngày|từ ngày)", re.I)
TECH_CODE_RE = re.compile(r"(^|_)(TEXT|IMARK|DESCRIPTION|DESC|LABEL|TITLE|VALUE|KEY|BUTTON|PLACEHOLDER|ERROR|MESSAGE|CONFIG|OPTION|PRODUCT|VARIANT)(_|\d|$)", re.I)
TECH_CONTEXT_RE = re.compile(r"(text_[a-z0-9_]+|i18n|translation|locale|json|description\d*\s*[:=]|imark_description|placeholder|localization)", re.I)


def dates_from(text):
    out=[]
    for d,m,y in DMY_RE.findall(text):
        try: out.append(dt.date(int(y),int(m),int(d)))
        except Exception: pass
    for d,m,y in ENG_RE.findall(text):
        try: out.append(dt.date(int(y),MONTHS[m.lower()],int(d)))
        except Exception: pass
    return out


def technical_token(code, text):
    code=(code or "").strip().upper()
    text=text or ""
    if not code:
        return True, "empty_code"
    if "_" in code:
        return True, "underscore_technical_token"
    if TECH_CODE_RE.search(code):
        return True, "technical_code_pattern"
    if TECH_CONTEXT_RE.search(text) and not re.search(r"(promo\s*code|voucher\s*code|coupon\s*code|mã\s+(?:giảm\s*giá|ưu\s*đãi|khuyến\s*mãi)|nhập\s*mã|use\s*code|apply\s*code)\s*[:\-]?\s*"+re.escape(code), text, re.I):
        return True, "technical_context"
    return False, None


def classify(text):
    text=text or ""
    dates=dates_from(text)
    if dates:
        latest=max(dates)
        if latest < TODAY:
            return "SHADOW_EXPIRED", latest.isoformat(), "explicit_latest_date_in_past"
        return "SHADOW_CURRENT", latest.isoformat(), "explicit_current_or_future_date"
    years=[int(y) for y in YEAR_RE.findall(text)]
    if years:
        latest=max(years)
        if latest < TODAY.year:
            return "SHADOW_EXPIRED", str(latest), "all_visible_years_in_past"
        if latest > TODAY.year:
            return "SHADOW_CURRENT", str(latest), "future_year_visible"
        return "SHADOW_REVIEW_DATE", str(latest), "current_year_without_parseable_end_date"
    if CURRENT_SIGNAL_RE.search(text):
        return "SHADOW_REVIEW_DATE", None, "date_language_without_parseable_date"
    return "SHADOW_REVIEW_DATE", None, "no_validity_evidence"


def main():
    if not QUEUE.exists():
        QUEUE.write_text("")
        print('{"total":0}')
        return
    rows=[]; counts={}
    for line in QUEUE.read_text(errors="replace").splitlines():
        try: r=json.loads(line)
        except Exception: continue
        is_tech,tech_reason=technical_token(r.get("literal_code"), r.get("context") or "")
        if is_tech:
            status,validity,reason="SHADOW_REJECT_TECHNICAL",None,tech_reason
        else:
            status,validity,reason=classify(r.get("context") or "")
        r["status"]=status
        r["validity_hint"]=validity
        r["date_gate_reason"]=reason
        r["production_commit_allowed"]=False
        counts[status]=counts.get(status,0)+1
        rows.append(r)
    QUEUE.write_text(''.join(json.dumps(r,ensure_ascii=False,sort_keys=True)+'\n' for r in rows),encoding='utf-8')
    print(json.dumps({"total":len(rows),"counts":counts},ensure_ascii=False))

if __name__ == '__main__':
    main()
