#!/usr/bin/env python3
import html
import json
import re
import ssl
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parent
STATE=ROOT/'state.json'
SEEN=ROOT/'seen_urls.txt'
UA='Mozilla/5.0 (compatible; SourceScanFree/1.0; +GitHub Actions Vietnam promo discovery)'
CTX=ssl.create_default_context()

TERMS=[
 'trung tâm thương mại','siêu thị','chuỗi bán lẻ','cửa hàng tiện lợi','thực phẩm sạch','mẹ và bé',
 'điện máy điện thoại laptop','nhà thuốc','mỹ phẩm làm đẹp','thời trang giày dép','trang sức',
 'nội thất gia dụng','nhà hàng cafe trà sữa','rạp chiếu phim','khách sạn resort','hãng bay du lịch',
 'giao đồ ăn gọi xe','ngân hàng thẻ tín dụng','ví điện tử','bảo hiểm','viễn thông internet',
 'giáo dục','phòng gym fitness','spa thẩm mỹ','ô tô xe máy','bất động sản','loyalty membership'
]
MODS=['khuyến mãi Việt Nam','ưu đãi Việt Nam','voucher Việt Nam','promotion Vietnam']
NOISE=('facebook.com','instagram.com','youtube.com','tiktok.com','linkedin.com','x.com','twitter.com','pinterest.com')


def load_json(p,d):
 try:return json.loads(p.read_text())
 except Exception:return d

def lines(p):
 if not p.exists():return []
 return [x.strip() for x in p.read_text(errors='replace').splitlines() if x.strip()]

def save_lines(p,v):p.write_text('\n'.join(sorted(set(v)))+('\n' if v else ''))

def norm(raw):
 try:
  if raw.startswith('//'):raw='https:'+raw
  u=urllib.parse.urlsplit(raw)
  if u.hostname and u.hostname.endswith('duckduckgo.com') and u.path.startswith('/l/'):
   q=urllib.parse.parse_qs(u.query); raw=(q.get('uddg') or [''])[0];u=urllib.parse.urlsplit(raw)
  if u.scheme not in ('http','https') or not u.hostname:return None
  h=u.hostname.lower().strip('.')
  if h.startswith('www.'):h=h[4:]
  if any(h==n or h.endswith('.'+n) for n in NOISE):return None
  return urllib.parse.urlunsplit((u.scheme,h,u.path or '/',u.query,''))
 except Exception:return None

def root(u):
 p=urllib.parse.urlsplit(u);return f'{p.scheme}://{p.netloc}/'

def search(q):
 url='https://html.duckduckgo.com/html/?'+urllib.parse.urlencode({'q':q})
 req=urllib.request.Request(url,headers={'User-Agent':UA,'Accept':'text/html,application/xhtml+xml'})
 with urllib.request.urlopen(req,timeout=25,context=CTX) as r:text=r.read(1000000).decode('utf-8',errors='replace')
 hrefs=[]
 for m in re.finditer(r'<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"',text,re.I):
  u=norm(html.unescape(m.group(1)))
  if u:hrefs.append(u)
 return hrefs[:40]

def main():
 s=load_json(STATE,{'version':1,'run_count':0,'frontier':[],'history':[]})
 seen=set(lines(SEEN));frontier=list(s.get('frontier') or [])
 cursor=int(s.get('free_search_cursor',0));total=len(TERMS)*len(MODS)
 added=0;queries=[];errors=0
 for step in range(4):
  i=(cursor+step)%total;term=TERMS[i//len(MODS)];mod=MODS[i%len(MODS)];q=f'{term} {mod}';queries.append(q)
  try:
   results=search(q)
  except Exception:
   errors+=1;results=[]
  for u in results:
   r=root(u)
   if r in seen or len(frontier)>=40000:continue
   seen.add(r);frontier.append({'url':r,'via':'free_search','seed':True});added+=1
  time.sleep(1.8)
 s['free_search_cursor']=(cursor+4)%total;s['free_search_last_queries']=queries;s['free_search_last_added']=added;s['free_search_last_errors']=errors;s['frontier']=frontier[:40000]
 STATE.write_text(json.dumps(s,ensure_ascii=False,indent=2,sort_keys=True)+'\n');save_lines(SEEN,seen)
 print(json.dumps({'queries':queries,'added_roots':added,'errors':errors,'frontier':len(frontier)},ensure_ascii=False))
if __name__=='__main__':main()
