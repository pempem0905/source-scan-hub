# PROMO Unified Runtime

This repository is the source-control and control-plane home for the PROMO source-discovery, extraction and L2 routing architecture.

## Authoritative systems

- **Source/control code:** GitHub `pempem0905/source-scan-hub` (`main`)
- **Canonical PROMO transaction state:** existing durable database/writer used by PROMO workers
- **Canonical source discovery/input owner:** `PROMO-SRC-HUNTER-V1`
- **Canonical downstream source input:** `integration/master_input_sources_v1.jsonl`
- **Dispatch plan:** `integration/promo_dispatch_plan_v1.jsonl`
- **Worker scheduler:** ChatGPT Scheduled Tasks for PROMO orchestration; GitHub Actions for Source Hunter and public L2 browser lanes

Database state is authoritative for PROMO counters/commits. GitHub is authoritative for the source registry, routing contracts and code/runtime architecture.

## Runtime topology

### Source plane

`PROMO-SRC-HUNTER-V1` owns broad discovery, source validation, canonicalization, registrable-domain dedup, source evidence and publication of the Master Input registry. Downstream PROMO workers do not run independent broad source discovery.

Source quality states:

- `ACTIVE_INPUT`: eligible for extraction/dispatch.
- `REVIEW_INPUT`: retained but held from extraction until source quality improves.
- `DISCOVERY_ONLY`: radar/discovery node; useful for discovering official sources but not a direct production extraction target.

### PROMO extraction plane

Active scheduled workers:

1. **PROMO Banks Shard** — extraction only for BANK_CARD / PAYMENT_WALLET / TRAVEL_MOBILITY records assigned `PROMO_BANKS`.
2. **PROMO Retail Shard** — extraction only for RETAIL_ECOMMERCE / FOOD_BEVERAGE / LOYALTY_REWARDS / GENERAL records assigned `PROMO_RETAIL`.
3. **PROMO Turbo Scan** — final quality gate and single canonical writer; no broad crawling.
4. **PROMO GPT Infra + Dispatch** — dispatcher, health/relay, canonical source-registry export bridge, queue/writer monitoring.

`PROMO Hub + L2 Sync` is paused because its discovery role is replaced by Source Hunter and its hard-access role is replaced by the L2 router.

### L2 plane

`PROMO-L2-ROUTER-V1` handles sources that need harder access. Routing order is cheapest/safest first:

`PUBLIC_HTTP -> JS_BROWSER -> PERSISTENT_PUBLIC -> AUTHORIZED_ACCOUNT / RESIDENTIAL_REQUIRED -> MANUAL_ONLY`

Public/JS work runs in GitHub Actions. Account/session lanes use only user-owned or authorized sessions on a persistent runner when available.

L2 output remains **shadow-only** until validated. `l2/candidate-queue.jsonl` never advances PROMO counters directly.

Candidate date states:

- `SHADOW_CURRENT`: explicit current/future date evidence; still requires Turbo verification.
- `SHADOW_REVIEW_DATE`: code context exists but validity is not sufficiently established.
- `SHADOW_EXPIRED`: explicit past validity; archive/reject for production.

## Unified data path

```text
Source Hunter / legacy registry / canonical PROMO source export
        -> Master Input quality gate
        -> dispatch plan
        -> Banks / Retail extraction
        -> difficult access -> L2 shadow lane
        -> promo_candidate_queue
        -> Turbo final validation + global dedup
        -> atomic canonical commit
        -> Infra verification/health
```

Incidental new domains found downstream are `SOURCE_CANDIDATE` feedback only. They must return to Source Hunter before becoming canonical input.

## Quality invariants

- ACTIONABLE-VALUE-V2 is mandatory.
- Official evidence is preferred; child/detail/terms controls economics and validity.
- Raw uppercase/regex text is never a verified promo code.
- Exact reusable literal promo codes require visible contextual code evidence.
- Dynamic/account/QR/OTP/referral/contest identifiers are not public literal codes.
- Expired offers/codes never enter the active production feed.
- Global source dedup key is registrable domain; URL variants live under source `entry_points`.
- Producers enqueue; only the single writer advances canonical PROMO state.
- Login/CAPTCHA/WAF are not bypassed. Account lanes reuse only authorized persistent sessions and stop for re-login when required.

## Machine-readable contracts

- `integration/project-manifest.json`
- `integration/work-allocation.json`
- `integration/master_input_sources_v1.jsonl`
- `integration/master_input_status.json`
- `integration/promo_dispatch_plan_v1.jsonl`
- `config/promo-workers.json`
- `l2/router.json`
- `l2/auth-status.json`

Never store API keys, passwords, OTPs, cookies, refresh tokens or other credentials in these GitHub files.
