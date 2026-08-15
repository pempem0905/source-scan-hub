import type { SourceType } from "./types";

export const RADAR_SOURCE_TYPES: ReadonlySet<SourceType> = new Set([
  "AFFILIATE_NETWORK",
  "AFFILIATE_PUBLISHER",
  "COUPON_AGGREGATOR",
  "DEAL_AGGREGATOR",
  "BLOG",
]);

export const OFFICIAL_SOURCE_TYPES: ReadonlySet<SourceType> = new Set([
  "BRAND_OFFICIAL",
  "MERCHANT_OFFICIAL",
  "BANK_OFFICIAL",
  "CARD_ISSUER_OFFICIAL",
  "MARKETPLACE_OFFICIAL",
  "PLATFORM_OFFICIAL",
]);

export const AUTHORITY_SCORE: Record<SourceType, number> = {
  BRAND_OFFICIAL: 100,
  MERCHANT_OFFICIAL: 100,
  BANK_OFFICIAL: 95,
  CARD_ISSUER_OFFICIAL: 95,
  MARKETPLACE_OFFICIAL: 90,
  PLATFORM_OFFICIAL: 90,
  AFFILIATE_NETWORK: 60,
  COUPON_AGGREGATOR: 40,
  DEAL_AGGREGATOR: 35,
  AFFILIATE_PUBLISHER: 30,
  BLOG: 20,
  OTHER: 10,
};

export function isRadarType(sourceType: SourceType): boolean {
  return RADAR_SOURCE_TYPES.has(sourceType);
}

export function isOfficialType(sourceType: SourceType): boolean {
  return OFFICIAL_SOURCE_TYPES.has(sourceType);
}

export function authorityFor(sourceType: SourceType): number {
  return AUTHORITY_SCORE[sourceType];
}

export const PROMO_PATH_HINTS = [
  "/khuyen-mai",
  "/khuyenmai",
  "/khuyen-mai-moi",
  "/uu-dai",
  "/uudai",
  "/voucher",
  "/vouchers",
  "/promotion",
  "/promotions",
  "/promo",
  "/offers",
  "/offer",
  "/deals",
  "/deal",
  "/sale",
] as const;

export const VIETNAM_MARKET_KEYWORDS = [
  "việt nam",
  "viet nam",
  "vietnam",
  "vn",
  "vnd",
  "₫",
  "hà nội",
  "ha noi",
  "hồ chí minh",
  "ho chi minh",
  "tp.hcm",
  "saigon",
] as const;

export const RADAR_QUERY_PATTERNS = [
  '"mã giảm giá"',
  '"ma giam gia"',
  '"voucher" "Việt Nam"',
  '"coupon" "Vietnam"',
  '"khuyến mãi"',
  '"khuyến mại"',
  '"ưu đãi"',
  '"săn deal"',
  '"deal hot"',
  '"ưu đãi ngân hàng"',
  '"khuyến mãi thẻ"',
  '"promo code" "Vietnam"',
] as const;

export const OFFICIAL_QUERY_SUFFIXES = [
  "khuyến mãi",
  "ưu đãi",
  "voucher",
  "promotion",
  "offers",
  "deals",
] as const;
