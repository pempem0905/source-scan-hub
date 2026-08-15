import type { SourceType } from "./types";

/**
 * Phase 1 domain classifier.
 *
 * "Vietnam market" means the whole internet ecosystem serving Vietnam,
 * regardless of TLD — .vn, .com, regional subdomains and global platforms
 * all qualify. Intermediary sites (aggregators, affiliate networks and
 * publishers, deal blogs) are RADAR sources: useful for discovery, but they
 * never replace an official brand/bank/platform origin.
 */

type Rule = { type: SourceType; hosts: string[] };

const AFFILIATE_NETWORKS = [
  "accesstrade.vn",
  "accesstrade.global",
  "adpia.vn",
  "masoffer.com",
  "masoffer.net",
  "interspace.vn",
  "civi.vn",
  "dinos.vn",
  "ecomobi.com",
  "involve.asia",
  "shopback.vn",
  "shopback.com",
  "admicro.vn",
  "clickpay.vn",
];

const COUPON_AGGREGATORS = [
  "picodi.com",
  "bloggiamgia.vn",
  "magiamgia.com",
  "magiamgiashopee.vn",
  "magiamgiashopee.com",
  "couponhub.vn",
  "cuponation.com.vn",
  "voucherfly.vn",
  "giamgia.vn",
  "mahoanggia.vn",
  "toidicafe.vn",
  "hotdeal.vn",
  "voucher.com.vn",
  "coupon.vn",
];

const DEAL_AGGREGATORS = [
  "websosanh.vn",
  "sosanhgia.com",
  "deal.com.vn",
  "sandeal.vn",
  "chotot.com",
  "muabannhanh.com",
];

const MARKETPLACES = [
  "shopee.vn",
  "lazada.vn",
  "tiki.vn",
  "sendo.vn",
  "tiktok.com",
  "amazon.com",
  "alibaba.com",
  "fptshop.com.vn",
  "thegioididong.com",
  "dienmayxanh.com",
  "cellphones.com.vn",
  "nguyenkim.com",
  "bachhoaxanh.com",
  "concung.com",
  "hasaki.vn",
];

const PLATFORMS = [
  "grab.com",
  "be.com.vn",
  "baemin.vn",
  "shopeefood.vn",
  "momo.vn",
  "zalopay.vn",
  "vnpay.vn",
  "viettelpay.vn",
  "traveloka.com",
  "booking.com",
  "agoda.com",
  "vietnamairlines.com",
  "vietjetair.com",
  "bambooairways.com",
  "galaxycine.vn",
  "cgv.vn",
  "vnexpress.net",
];

const BANKS = [
  "vietcombank.com.vn",
  "techcombank.com.vn",
  "bidv.com.vn",
  "vietinbank.vn",
  "agribank.com.vn",
  "acb.com.vn",
  "vpbank.com.vn",
  "mbbank.com.vn",
  "tpb.vn",
  "sacombank.com.vn",
  "hdbank.com.vn",
  "vib.com.vn",
  "shb.com.vn",
  "msb.com.vn",
  "seabank.com.vn",
  "ocb.com.vn",
  "eximbank.com.vn",
  "scb.com.vn",
  "hsbc.com.vn",
  "shinhan.com.vn",
  "standardchartered.com.vn",
  "unitedoverseasbank.com.vn",
  "cake.vn",
  "timo.vn",
];

const CARD_ISSUERS = ["visa.com.vn", "visa.com", "mastercard.com", "jcb.co.jp", "amex.com"];

const RULES: Rule[] = [
  { type: "AFFILIATE_NETWORK", hosts: AFFILIATE_NETWORKS },
  { type: "COUPON_AGGREGATOR", hosts: COUPON_AGGREGATORS },
  { type: "DEAL_AGGREGATOR", hosts: DEAL_AGGREGATORS },
  { type: "MARKETPLACE_OFFICIAL", hosts: MARKETPLACES },
  { type: "PLATFORM_OFFICIAL", hosts: PLATFORMS },
  { type: "BANK_OFFICIAL", hosts: BANKS },
  { type: "CARD_ISSUER_OFFICIAL", hosts: CARD_ISSUERS },
];

const COUPON_HOST_TOKENS = [
  "magiamgia",
  "giamgia",
  "khuyenmai",
  "khuyen-mai",
  "voucher",
  "coupon",
  "uudai",
  "promo",
  "discount",
  "sale",
];

const DEAL_HOST_TOKENS = ["deal", "dealsan", "sanhang", "sosanh", "compare"];
const BLOG_HOST_TOKENS = ["blog", "review", "tips", "cam-nang", "camnang"];
const BANK_HOST_TOKENS = ["bank", "nganhang"];

function hostOf(input: string): string {
  try {
    return new URL(input).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return input.replace(/^www\./i, "").toLowerCase();
  }
}

/**
 * Best-effort source type for a discovered URL. Returns "OTHER" when the
 * evidence is too weak — Phase 1 prefers an honest unknown over a guess.
 */
export function classifySourceType(urlOrDomain: string): SourceType {
  const host = hostOf(urlOrDomain);
  if (!host) return "OTHER";

  for (const rule of RULES) {
    if (rule.hosts.some((known) => host === known || host.endsWith(`.${known}`))) return rule.type;
  }

  if (BANK_HOST_TOKENS.some((token) => host.includes(token))) return "BANK_OFFICIAL";
  if (COUPON_HOST_TOKENS.some((token) => host.includes(token))) return "COUPON_AGGREGATOR";
  if (DEAL_HOST_TOKENS.some((token) => host.includes(token))) return "DEAL_AGGREGATOR";
  if (BLOG_HOST_TOKENS.some((token) => host.includes(token))) return "BLOG";

  return "OTHER";
}
