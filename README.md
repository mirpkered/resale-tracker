# Resale Tracker

Personal resale inventory and profit tracking. Version 0.1 is a React, TypeScript, and Vite single-page app, designed for GitHub Pages with optional private storage through Supabase.

**Demo mode:** With no Supabase settings, the app uses a labeled deterministic sample dataset and stores edits in this browser's local storage. These demo records are not persisted to an account, are not synchronized between devices, and are not production financial records.

## Local development

Requirements: Node.js 22 or newer and npm.

```sh
npm ci
npm run dev
```

The GitHub Pages base path is `/resale-tracker/`. For local preview, Vite serves the app at `/resale-tracker/` as well.

## Supabase setup

1. Create a Supabase project and keep its database password out of this repository.
2. Apply `supabase/migrations/202611040001_initial_schema.sql` using the Supabase SQL Editor or the Supabase CLI (`supabase link`, then `supabase db push`). The schema includes owner-scoped tables, composite owner foreign keys, RLS policies, transaction-safe sale/refund RPCs, and an auth profile trigger.
3. In Supabase Authentication, enable the desired sign-in method. Create/invite your first user from the Supabase dashboard; public self-registration is intentionally not enabled by this app.
4. Set the Authentication Site URL and redirect URL to `https://mirpkered.github.io/resale-tracker/` after the GitHub repository exists. For local development, also allow `http://localhost:5173/`.
5. Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` plus `VITE_SUPABASE_ANON_KEY` from the project's API settings.

Only the public anon/publishable key belongs in browser configuration. Never set a service-role key in a `VITE_` variable, commit a real `.env` file, or place credentials in source control. Supabase RLS is the boundary for user-owned records; do not disable it.

The SQL isolation check is in `supabase/tests/rls.sql`; run it against a local Supabase database with `supabase test db` after installing/linking the Supabase CLI. The test uses two distinct authenticated identities and also checks an owner-mismatched foreign key.

## GitHub Pages deployment

The repository is not connected to GitHub yet. Once it is created as `mirpkered/resale-tracker`:

1. Push the `main` branch to that repository.
2. In repository **Settings → Pages → Build and deployment**, select **GitHub Actions**.
3. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as repository Actions **Variables** (these are public frontend values; do not use the service-role key). Leaving them unset deploys the clearly labeled demo experience.
4. The workflow `.github/workflows/deploy.yml` runs lint, TypeScript validation, unit tests, and a production build on pushes and pull requests; a successful push to `main` deploys the artifact to GitHub Pages.

The expected URL is <https://mirpkered.github.io/resale-tracker/>. No deployment is claimed until the repository and Pages workflow are configured and a successful run completes.

## Accounting and data behavior

- Monetary values are integer cents; UI parsing rejects fractions beyond two decimal places.
- Purchase lot costs and additional acquisition expenses are separate from item allocations. Unallocated lot value remains visible.
- Cash proceeds appear only after a payment is confirmed. Profit reports include completed paid sales and reflect recorded refunds.
- Unsold asking value is potential revenue and is never included as income.
- Store credit has a separate ledger representation and is not counted as cash.
- Sales can contain multiple inventory items and partial quantities. The database procedure locks item rows and reconciles the allocated cost to the current inventory balance.
- Archive flags hide records from the active inventory view without deleting history.
- ChatGPT Project conversations are not accessed automatically. JSON and CSV imports use schema `1.0`; each record has a stable `sourceId` and a preview before confirmation. Suggested prices remain separate from confirmed asking prices. Examples: `public/examples/listing-import.v1.json` and `.csv`.

## Current v0.1 boundaries

The working entry flows cover purchase lots, inventory and listing details, sales and bundle allocations, payment confirmation, cash expenses, returns/refunds, monthly cash summaries, reports, CSV export, and manual JSON/CSV imports. The UI edits one primary listing at a time while preserving other platform listings. Images are saved as references; binary photo storage is not included. Store-credit and trade-in ledgers, inventory adjustment history, and audit/import-history browsing have schema support but still need dedicated management screens. Demo mode persists only to the current browser.

## Quality checks

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

Unit tests use deterministic data for cent math, lot allocation, partial/bundle sale allocation, confirmed versus unpaid sales, cash position, realized profit, store credit separation, refunds/returns, JSON/CSV duplicate import preview, and status transitions. Cross-user isolation is exercised separately by the Supabase pgTAP test and requires a local database.
