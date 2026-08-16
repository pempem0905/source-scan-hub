# PROMO Bot Runtime

This repository is the source-control home for the PROMO Source Scan Hub backend and the mirrored architecture of the ChatGPT PROMO workers.

## Authoritative systems

- **Source code:** GitHub `pempem0905/source-scan-hub` (`main`)
- **App/backend:** Lovable `source-scan-hub`
- **Database / canonical transaction state:** Supabase attached to Source Scan Hub
- **Worker scheduler:** ChatGPT Scheduled Tasks
- **Live status:** `https://source-scan-hub.lovable.app/api/promo-status`

The database/live status is authoritative for batch counters. File Library exports and dashboard snapshots are mirrors only and may lag.

## Worker topology

The current runtime uses five hourly workers:

1. Banks + Travel/Payment producer
2. Retail + F&B + Lifestyle producer
3. Discovery Hub producer
4. Turbo single-writer commit coordinator
5. Infra health/relay worker

The machine-readable mirror is stored in `config/promo-workers.json`.

## Data path

`ChatGPT workers -> official web evidence -> promo_candidate_queue -> Turbo/Infra validation -> atomic master commit -> promo_master_state / promo_master_commits -> /api/promo-status`

## Safety / quality invariants

- ACTIONABLE-VALUE-V2 is mandatory.
- Official source evidence is preferred.
- Child/detail/terms evidence overrides ambiguous hubs.
- Exact reusable literal promo codes are stored only when visibly published by official evidence.
- Dynamic/account/QR/OTP/referral/contest identifiers are not literal promo codes.
- Producers enqueue; only the single writer advances canonical counters.
- Global dedup and post-commit verification are required.

## GitHub synchronization

Lovable source edits are already synchronized to this repository. ChatGPT Scheduled Task prompts are not natively stored in GitHub by OpenAI, so `config/promo-workers.json` is a version-controlled mirror of roles, scopes and runtime invariants rather than a credential-bearing export of the task prompts.

No API keys, tokens, cookies or other secrets should be written into this mirror.
