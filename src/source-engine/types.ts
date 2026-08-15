export const SOURCE_TYPES = [
  "BRAND_OFFICIAL",
  "MERCHANT_OFFICIAL",
  "BANK_OFFICIAL",
  "CARD_ISSUER_OFFICIAL",
  "MARKETPLACE_OFFICIAL",
  "PLATFORM_OFFICIAL",
  "AFFILIATE_NETWORK",
  "AFFILIATE_PUBLISHER",
  "COUPON_AGGREGATOR",
  "DEAL_AGGREGATOR",
  "BLOG",
  "OTHER",
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

export const WORKER_LANES = [
  "SEARCH_DISCOVERY",
  "DOMAIN_EXPANDER",
  "SITEMAP_HUNTER",
  "PROMO_PATH_HUNTER",
  "ORIGIN_RESOLVER",
  "CLASSIFIER_DEDUPER",
  "RETRY",
] as const;

export type WorkerLane = (typeof WORKER_LANES)[number];

export type ResolutionStatus =
  | "pending"
  | "resolved"
  | "unresolved"
  | "blocked"
  | "failed";

export type SourceStatus =
  | "new"
  | "candidate"
  | "verified"
  | "duplicate"
  | "rejected"
  | "dead";

export interface SourceCandidateInput {
  url: string;
  domain?: string | null;
  sourceType?: SourceType | null;
  discoveredVia?: string | null;
  discoverySourceId?: string | null;
  merchantId?: string | null;
  market?: string;
  notes?: string | null;
}

export interface NormalizedUrl {
  originalUrl: string;
  normalizedUrl: string;
  normalizedDomain: string;
  removedTrackingParams: string[];
}

export interface OriginResolution {
  discoveredUrl: string;
  finalUrl: string;
  canonicalUrl: string;
  canonicalDomain: string;
  redirectChain: string[];
  httpStatus: number | null;
  resolutionStatus: ResolutionStatus;
  confidence: number;
  error?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  description?: string;
  source: "brave" | "common_crawl" | "seed" | "sitemap" | "outgoing_link";
  query?: string;
}

export interface WorkerHeartbeat {
  workerId: string;
  lane: WorkerLane;
  status: "idle" | "running" | "paused" | "error";
  requestsTotal?: number;
  qualifiedSourcesTotal?: number;
  errorsTotal?: number;
  rate403?: number;
  rate429?: number;
  currentJobId?: string | null;
}
