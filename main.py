import requests
import json
import os
import xml.etree.ElementTree as ET
import time
from datetime import datetime

def classify_sector_and_type(title):
    text = title.lower()
    sector = "TongHop"
    deal_type = "KhuyenMai"
    
    if any(kw in text for kw in ["ngân hàng", "bank", "thẻ", "visa", "mastercard", "vay", "lãi suất", "hoàn tiền", "momo", "zalopay", "vnpay"]):
        sector = "NganHang_TaiChinh"
    elif any(kw in text for kw in ["shopee", "lazada", "tiki", "sàn", "tmdt", "thương mại điện tử", "tiktok shop", "sale"]):
        sector = "SanTMDT"
    elif any(kw in text for kw in ["nike", "adidas", "uniqlo", "zara", "h&m", "thời trang", "giày", "quần áo", "sneaker"]):
        sector = "ThoiTrang_ThuongHieu"
    elif any(kw in text for kw in ["vincom", "aeon", "lotte mall", "trung tâm thương mại", "tttm", "crescent mall"]):
        sector = "TrungTamThuongMai"
    elif any(kw in text for kw in ["home farm", "winmart", "co.op", "bách hóa", "go!", "siêu thị", "thực phẩm", "organic"]):
        sector = "SieuThi_ThucPham"
    elif any(kw in text for kw in ["f&b", "cafe", "nhà hàng", "quán", "ăn uống", "trà sữa", "coffee", "highlands", "phúc long"]):
        sector = "FnB_AmThuc"
    elif any(kw in text for kw in ["du lịch", "vé máy bay", "khách sạn", "tour", "resort", "agoda", "booking"]):
        sector = "DuLich_Booking"

    if any(kw in text for kw in ["mã", "voucher", "coupon", "code", "nhập mã"]):
        deal_type = "MaGiamGia"
    elif any(kw in text for kw in ["giảm", "%", "đồng", "k", "triệu", "ưu đãi", "đặc quyền", "tặng"]):
        deal_type = "UuDai_Gia"
    elif any(kw in text for kw in ["điều kiện", "áp dụng", "lưu ý"]):
        deal_type = "DieuKienSuDung"

    return sector, deal_type

def run_scanner():
    print(f"\n==================================================")
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] 📊 BÁO CÁO HỆ THỐNG ĐỊNH KỲ 1 GIỜ")
    print(f"==================================================")
    
    config_file = 'sources.json'
    if not os.path.exists(config_file):
        print(">>> Lỗi: Không tìm thấy sources.json")
        return
        
    with open(config_file, 'r', encoding='utf-8') as f:
        config = json.load(f)
        
    sources_list = config.get("sources", [])
    print(f"👉 Tổng số Input Sources đang theo dõi: {len(sources_list)} nguồn")
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    }
    
    new_deals = []
    for src in sources_list:
        platform = src.get("platform")
        url = src.get("url")
        default_sector = src.get("sector", "TongHop")
        try:
            res = requests.get(url, headers=headers, timeout=10)
            if res.status_code == 200:
                root = ET.fromstring(res.content)
                items = root.findall('./channel/item')
                for item in items[:25]:
                    title = item.find('title').text if item.find('title') is not None else "Khuyến mãi"
                    link = item.find('link').text if item.find('link') is not None else ""
                    description = item.find('description').text if item.find('description') is not None else ""
                    
                    sector, deal_type = classify_sector_and_type(title + " " + description)
                    if sector == "TongHop":
                        sector = default_sector
                    
                    new_deals.append({
                        "platform": platform,
                        "sector": sector,
                        "type": deal_type,
                        "title": title.strip(),
                        "link": link.strip(),
                        "condition": "Áp dụng theo điều khoản chương trình",
                        "active": True,
                        "scanned_at": datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                    })
        except:
            pass

    db_file = 'deals.json'
    db_content = {"status": "active", "deals": []}
    if os.path.exists(db_file):
        with open(db_file, 'r', encoding='utf-8') as f:
            try:
                db_content = json.load(f)
            except:
                pass
                
    if "deals" not in db_content:
        db_content["deals"] = []

    existing_links = {d.get("link") for d in db_content["deals"]}
    added_count = 0
    voucher_count = 0
    code_count = 0
    
    for deal in new_deals:
        if deal["link"] and deal["link"] not in existing_links:
            db_content["deals"].append(deal)
            existing_links.add(deal["link"])
            added_count += 1
            if deal["type"] == "MaGiamGia":
                code_count += 1
            elif deal["type"] == "UuDai_Gia":
                voucher_count += 1

    with open(db_file, 'w', encoding='utf-8') as f:
        json.dump(db_content, f, ensure_ascii=False, indent=4)
        
    print(f"✨ Kết quả quét trong giờ qua:")
    print(f"   - Thêm mới: {added_count} bản ghi")
    print(f"   - Số lượng Mã giảm giá / Voucher phát hiện: {code_count + voucher_count}")
    print(f"📦 Tổng kho dữ liệu hiện tại: {len(db_content['deals'])} deals")
    print(f"==================================================\n")

if __name__ == "__main__":
    print(">>> KÍCH HOẠT HỆ THỐNG BÁO CÁO TỰ ĐỘNG MỖI 1 GIỜ...")
    while True:
        try:
            run_scanner()
        except Exception as e:
            print(f"Lỗi chu kỳ: {e}")
        print(">>> Đang chuyển sang chế độ ngủ đông, sẽ tự động báo cáo lại sau 1 giờ...")
        time.sleep(3600)
