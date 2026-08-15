# Phase 1 Source Engine

This phase builds a Vietnam-market source map only. It does **not** perform bulk promo/code extraction.

## Market scope

`VN` means the entire internet ecosystem serving users in Vietnam, regardless of TLD. `.vn` is only one signal among many.

## Source layers

1. **Radar** — coupon aggregators, affiliate publishers/networks, deal blogs. Kept as discovery evidence but never preferred as canonical output.
2. **Official** — brands, merchants, banks/card issuers, marketplaces and official platforms.
3. **Origin Resolver** — follows redirects, strips tracking parameters and prefers canonical URLs/domains.

## Worker lanes

- `SEARCH_DISCOVERY`
- `DOMAIN_EXPANDER`
- `SITEMAP_HUNTER`
- `PROMO_PATH_HUNTER`
- `ORIGIN_RESOLVER`
- `CLASSIFIER_DEDUPER`
- `RETRY`

The database queue is claimed atomically using `FOR UPDATE SKIP LOCKED`, so multiple workers do not claim the same row.

## Secrets

Configure these only as server-side secrets; never place real values in Git:

- `APIFY_TOKEN`
- `BRAVE_SEARCH_API_KEY`
- `SOURCE_WORKER_TOKEN`

`SOURCE_WORKER_TOKEN` protects the external worker API under `/api/source-engine/$action`. Apify workers should know this shared worker token, not the Supabase service-role key.

## Worker API

All requests use `POST`, JSON, and `Authorization: Bearer <SOURCE_WORKER_TOKEN>`.

Actions:

- `/api/source-engine/candidates` — ingest up to 500 source candidates.
- `/api/source-engine/heartbeat` — update worker telemetry.
- `/api/source-engine/claim` — atomically claim the next queue item.
- `/api/source-engine/resolution` — report canonical/origin resolution.
- `/api/source-engine/complete` — complete a queue item.
- `/api/source-engine/retry` — release a queue item with delay.
- `/api/source-engine/fail` — permanently fail a queue item.
- `/api/source-engine/usage` — aggregate provider request/credit/cost metrics.

## Performance rule

Optimize for **qualified unique sources per 1,000 requests**, not raw pages crawled. HTTP requests are preferred; browser rendering is reserved for hard/JS-only sources.

## Initial power modes

- `ECO`: 16 global concurrency
- `AUTO`: 64 global concurrency
- `MAX_SPEED`: up to 256 logical HTTP concurrency, still capped by per-domain concurrency and Apify's 32 Actor-run plan limit

The actual provider limits and project budget remain hard constraints.
