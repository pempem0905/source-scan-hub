#!/usr/bin/env python3
"""Taxonomy dùng chung cho PROMO source pipeline.

Giữ nguyên vertical legacy để không phá worker routing, đồng thời thêm
consumer_category chi tiết hơn cho coverage/reporting và market relevance.
"""
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

VN_DOMAIN_RE = re.compile(r"(?:^|\.)(?:com\.vn|net\.vn|org\.vn|vn)$", re.I)
VN_SIGNAL_RE = re.compile(r"(?:/vn(?:/|$)|/vi(?:/|$)|vi-vn|vietnam|viet-nam|việt\s*nam)", re.I)

CATEGORY_PATTERNS = [
    ("MALL", r"vincom|aeonmall|lotte.?mall|crescent.?mall|estella.?place|gigamall|thiso.?mall|saigon.?centre|takashimaya|van.?hanh.?mall"),
    ("SUPERMARKET_GROCERY", r"winmart|bachhoaxanh|bách.?hóa.?xanh|coop(?:online|mart)?|lotte.?mart|mmvietnam|mega.?market|emart|aeon(?:\.com)?|homefarm|supermarket|siêu.?thị|sieu.?thi"),
    ("CONVENIENCE", r"circle.?k|gs25|familymart|ministop|7-eleven|convenience"),
    ("PHARMACY_HEALTH", r"long.?chau|pharmacity|an.?khang|nhathuoc|nhà.?thuốc|pharmacy|medicare|vnvc"),
    ("BEAUTY_PERSONAL_CARE", r"guardian|watsons|hasaki|sammishop|sociolla|beauty|cosmetic|mỹ.?phẩm|my.?pham"),
    ("MOTHER_BABY", r"concung|con.?cưng|avakids|bibomart|kidsplaza|mother|baby|mẹ.?và.?bé|me.?va.?be"),
    ("ELECTRONICS", r"thegioididong|điện.?máy.?xanh|dienmayxanh|fptshop|cellphones|viettelstore|nguyenkim|phongvu|electronics|laptop|mobile"),
    ("JEWELRY", r"pnj|doji|sjc|jewel|jewelry|trang.?sức|trang.?suc"),
    ("FASHION_APPAREL", r"uniqlo|hm\.com|h&m|yody|canifa|coolmate|ivymoda|routine|anphuoc|nemshop|charleskeith|acfc|maisononline|fashion|apparel|thời.?trang|thoi.?trang"),
    ("FOOTWEAR_ACCESSORIES", r"bitis|juno|vascara|nike|adidas|puma|skechers|crocs|footwear|shoes|giày|giay"),
    ("HOME_LIVING", r"dienmaycholon|locknlock|jysk|indexliving|noithat|nội.?thất|gia.?dụng|gia.?dung|home.?living"),
    ("MARKETPLACE", r"shopee(?:\.vn)?|lazada|tiki(?:\.vn)?|tiktokshop|tiktok\.com"),
    ("FOOD_BEVERAGE", r"highlands|phuclong|phúc.?long|thecoffeehouse|coffee.?house|kfc|lotteria|jollibee|pizza4ps|pizza.?hut|domino|starbucks|gongcha|koi.?the|tocotoco|katinat|golden.?gate|restaurant|coffee|cafe|trà.?sữa|tra.?sua"),
    ("ENTERTAINMENT", r"cgv|galaxycine|lottecinema|betacinema|bhdstar|cinema|cine|rạp.?chiếu|rap.?chieu|theme.?park|sunworld"),
    ("BANK_CARD", r"vpbank|vietcombank|techcombank|acb\.com|bidv|vietinbank|mbbank|vib\.com|sacombank|hdbank|ocb\.com|tpbank|seabank|msb\.com|shinhan|hsbc|standardchartered|woori|eximbank|agribank|bank"),
    ("PAYMENT_WALLET", r"momo|zalopay|vnpay|shopeepay|vnptpay|vnpt.?money|wallet|ví.?điện.?tử|vi.?dien.?tu"),
    ("TRAVEL_AIRLINE", r"vietnamairlines|vietjetair|bambooairways|vietravelairlines|airline|flight|hãng.?bay|hang.?bay"),
    ("TRAVEL_OTA_HOTEL", r"traveloka|booking\.com|agoda|klook|trip\.com|vinpearl|hotel|resort|travel|du.?lịch|du.?lich"),
    ("MOBILITY_DELIVERY", r"grab(?:\.com)?|be\.com\.vn|xanhsm|gojek|shopeefood|delivery|giao.?đồ.?ăn|giao.?do.?an|mobility|ride.?hailing"),
    ("LOYALTY_GIFTCARD", r"taptap|urbox|gotit|vinid|loyalty|reward|membership|gift.?card|voucher.?platform"),
    ("TELECOM", r"vietteltelecom|mobifone|vnpt|fpt\.vn|telecom|viễn.?thông|vien.?thong"),
    ("INSURANCE", r"baoviet|prudential|manulife|aia\.com|insurance|bảo.?hiểm|bao.?hiem"),
    ("FITNESS_WELLNESS", r"californiafitness|citigym|elitefitness|the.?new.?gym|fitness|gym|spa|wellness|thẩm.?mỹ|tham.?my"),
    ("EDUCATION", r"apollo|vus\.edu|ila\.edu|wallstreetenglish|education|school|academy|giáo.?dục|giao.?duc"),
    ("AUTOMOTIVE", r"vinfast|honda\.com\.vn|yamaha-motor|toyota\.com\.vn|ford\.com\.vn|automotive|ô.?tô|o.?to|xe.?máy|xe.?may"),
]

COMPILED = [(name, re.compile(pattern, re.I)) for name, pattern in CATEGORY_PATTERNS]

RETAIL_CATEGORIES = {
    "MALL", "SUPERMARKET_GROCERY", "CONVENIENCE", "PHARMACY_HEALTH",
    "BEAUTY_PERSONAL_CARE", "MOTHER_BABY", "ELECTRONICS", "JEWELRY",
    "FASHION_APPAREL", "FOOTWEAR_ACCESSORIES", "HOME_LIVING", "MARKETPLACE",
    "ENTERTAINMENT", "TELECOM", "INSURANCE", "FITNESS_WELLNESS",
    "EDUCATION", "AUTOMOTIVE",
}


def _text(domain, names=None, entry_points=None):
    names = names or []
    entry_points = entry_points or []
    return " ".join([domain or "", " ".join(names), " ".join(entry_points[:12])])


def consumer_category_for(domain, names=None, entry_points=None):
    domain = domain or ""
    # Ưu tiên nhận dạng trên domain để promo của ngân hàng không làm sai ngành brand.
    for category, rx in COMPILED:
        if rx.search(domain):
            return category
    text = _text(domain, names, entry_points)
    for category, rx in COMPILED:
        if rx.search(text):
            return category
    return "OTHER_CONSUMER"


def vertical_for(domain, names=None, entry_points=None):
    category = consumer_category_for(domain, names, entry_points)
    if category == "BANK_CARD":
        return "BANK_CARD"
    if category == "PAYMENT_WALLET":
        return "PAYMENT_WALLET"
    if category == "FOOD_BEVERAGE":
        return "FOOD_BEVERAGE"
    if category in {"TRAVEL_AIRLINE", "TRAVEL_OTA_HOTEL", "MOBILITY_DELIVERY"}:
        return "TRAVEL_MOBILITY"
    if category == "LOYALTY_GIFTCARD":
        return "LOYALTY_REWARDS"
    if category in RETAIL_CATEGORIES:
        return "RETAIL_ECOMMERCE"
    return "GENERAL"


def load_catalog_domains(catalog_path):
    try:
        data = json.loads(Path(catalog_path).read_text())
    except Exception:
        return set()
    out = set()
    for category in data.get("categories") or []:
        for target in category.get("targets") or []:
            for domain in target.get("domains") or []:
                d = str(domain).lower().strip().strip(".")
                if d.startswith("www."):
                    d = d[4:]
                if d:
                    out.add(d)
    return out


def market_relevance_score(domain, names=None, entry_points=None, origins=None, methods=None, catalog_domains=None):
    domain = (domain or "").lower()
    names = names or []
    entry_points = entry_points or []
    origins = set(origins or [])
    methods = set(methods or [])
    catalog_domains = catalog_domains or set()
    text = _text(domain, names, entry_points)
    score = 0
    if VN_DOMAIN_RE.search(domain):
        score += 45
    if VN_SIGNAL_RE.search(text):
        score += 25
    if domain in catalog_domains:
        score += 35
    if origins & {"PROMO_LEGACY_SEED", "PROMO_CANONICAL_EXPORT"}:
        score += 25
    if "curated_seed" in methods:
        score += 20
    return max(0, min(100, score))
