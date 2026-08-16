# Source Scan Hub

Source Control Center Scan

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://source-scan-hub.lovable.app

**Live monitoring**: https://source-scan-hub.lovable.app/promo — PROMO master progress, writer health, candidate queue and commit ledger. All live metrics are read from the canonical Supabase master tables (`promo_master_state`, `promo_writer_health`, `promo_candidate_queue`, `promo_master_commits`, `worker_stats`); no values are hard-coded.

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/531b7c18-ea2e-45bb-897c-9de8a6ca020d).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
