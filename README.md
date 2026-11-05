# Resale Tracker

Personal resale inventory and profit tracking. Version 0.6 uses React, TypeScript, and Vite. The daily automatic-sync app is served by a same-origin Cloudflare Worker and reads/writes a narrowly scoped private GitHub data repository. GitHub Pages remains the public local/manual recovery frontend. This is not a Mirpworks application.

## Version 0.6 mobile and branding

The approved green basket artwork is stored in `public/resale-tracker-icon.png`; generated 32, 180, 192, and 512 pixel icons live in `public/icons/`. The manifest uses paths relative to its own URL so both the GitHub Pages `/resale-tracker/` build and the Worker `/` build can install the app. On iPhone, open the deployed app and use the browser share menu's **Add to Home Screen** action. The app keeps local edits queued while offline and reports cloud persistence only after the Worker confirms a revision.

Inventory search covers title, description, category, platform, lifecycle status, and purchase lot. Lot, platform, category, and status filters can be combined, and the results can be sorted by title, cost, asking price, or quantity.

## Storage and security

The secure app uses a Cloudflare Worker to serve both static assets and `/api/*` from one origin. GitHub OAuth callback, PKCE/state verification, private snapshot reads/writes, and encrypted HttpOnly session cookies stay on the Worker. GitHub App user tokens are never sent to browser JavaScript or saved in localStorage. The App is configured for only the private `mirpkered/resale-tracker-data` repository with Contents read/write and Metadata read access; the backend pins the owner, repository, branch, and allowed GitHub login.

The Worker validates each revision-based batch, creates the new canonical snapshot and prior-revision backup in one Git commit, fast-forward updates the private `main` ref, and reads the snapshot back before reporting a save. Offline edits remain queued in browser local storage. Revision conflicts preserve local work for explicit reconciliation. The private repo remains canonical; demo data remains separate.

**Setup status:** the Worker code and UI are implemented and locally tested. Automatic sync is not operational until the GitHub App and Worker secrets are configured and an authenticated read/write/reload cycle succeeds. See [Automatic Sync Setup](public/docs/automatic-sync-setup.md) for the architecture, security model, iPhone first-connection steps, and setup guide. The GitHub Pages URL is a local/manual fallback because Safari blocks cross-site cookies; use the Worker URL for authenticated daily use.

### Advanced manual recovery

The Imports screen keeps the batch export and canonical snapshot import controls inside **Advanced backup and manual GitHub recovery**. These remain useful for GitHub Pages fallback, backups, and restoring older snapshots. New writes should use automatic sync after its setup completes. The same stable batch IDs and revision checks prevent duplicate retry commits.

## Initial setup and local development

Node.js 22 and npm are required.

```sh
git clone https://github.com/mirpkered/resale-tracker.git
cd resale-tracker
npm ci
npm run dev
```

The GitHub Pages build uses `/resale-tracker/`; `npm run build:worker` uses `/` and turns on the same-origin automatic-sync UI. `npm run preview` serves the local Pages build. Worker secrets are configured in Cloudflare, never Vite variables or committed files.

## GitHub repositories and deployment

- Public app: [`mirpkered/resale-tracker`](https://github.com/mirpkered/resale-tracker), deployed to <https://mirpkered.github.io/resale-tracker/>.
- Private data: [`mirpkered/resale-tracker-data`](https://github.com/mirpkered/resale-tracker-data), canonical empty document and sync workflow on `main`.

The Pages workflow in `.github/workflows/deploy.yml` installs dependencies, lints, type-checks, tests, builds, and deploys on pushes to `main`. The secure app workflow in `.github/workflows/deploy-worker.yml` validates on relevant changes and deploys the Worker when explicitly enabled with a Cloudflare deployment token. Set Pages source to **GitHub Actions**. Never add GitHub App credentials or financial records to the public app repository. The private repo's existing workflow remains available for recovery; automatic app writes use its Git data API directly and do not run Actions.

## Schema and historical migrations

`current/resale-data.v2.json` uses data schema `2.0` and stores lots, inventory, sales, expenses, store credit, platforms, batch hashes, revision numbers, and audit summaries. Monetary values are integer cents. `scripts/data-contract.mjs` validates ownership-internal references, lot allocation bounds, amounts, schema, retries, revision conflicts, and restore behavior. `scripts/sync-data.mjs` stages the canonical snapshot and audit log and commits the changed files together. A failed workflow does not create a Git commit.

The former `supabase/` SQL migrations and RLS test are retained as historical v0.1 reference only. The v0.2 application does not connect to or require Supabase.

## Import, accounting, and migration (v0.4)

The dedicated [ChatGPT import guide](public/docs/chatgpt-import-guide.md) documents the current `resale-tracker-migration` schema version `1.0`, stable ID rules, every supported field, verification statuses, and a full format example. The [formal JSON Schema](public/docs/resale-migration.schema.v1.json) is linked in the guide. The [downloadable template](public/examples/migration-template.v1.json) is empty and does not contain user records. ChatGPT Project access remains manual; the app does not read conversations automatically.

Use **Reconciliation** to preview new and existing rows, possible duplicates, conflicts, missing/unverified fields, inventory quantity, purchase investment, confirmed asking value, confirmed cash, expected future proceeds, and realized profit. The preview does not write private GitHub storage. Stable IDs make repeated imports idempotent; changed values require per-record conflict approval and a separate import confirmation. User-edited fields remain until that conflict is explicitly approved.

Purchase groups are reporting labels. Each underlying purchase remains a separate lot with its own date, cost, expenses, allocations, and transactions. Import only information supported by the user's source records; mark uncertain values as estimated, suggested, pending, or unknown. Do not infer sales from asking prices or offers, and do not preload historical inventory.

A `cash_sale` transaction may link item external IDs and their quantities. On first import, it reduces available stock, links individual unit IDs, allocates net proceeds and acquisition cost, and contributes realized profit only for confirmed payment and confirmed item cost. Stable transaction IDs prevent replay from reducing stock twice. Do not change the quantities on a previously imported sale in a later batch: record the return or inventory adjustment first. Asking prices and offers never count as sale revenue. Store credit and rewards stay separate from cash.

Manual item editing covers descriptions, purchase lot, quantity, allocated cost, asking prices, platform, listing state, and notes. Sales and imported financial transactions can be edited in the app; changing gross, fees, shipping, expenses, or payment status recalculates confirmed cash and profit. Each local write adds a bounded audit entry. When authenticated in the Worker-hosted app, every approved edit automatically enters the revision-checked save queue; the Pages copy remains local until connected through a same-origin secure backend.

No sample inventory is seeded into the personal workspace or private data repository. The demo workspace remains separate.

## Validation

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

Tests include cents and lot reconciliation, paid/unpaid proceeds, partial and bundled lines, refunds, status transitions, import duplicate previews, storage serialization, demo isolation, revision conflicts, retry idempotency, failed validation recovery, backup restoration, grouped-purchase totals, migration matching, estimated values, pending offers, copy units, partial imported cash sales, repeat imports, migration financial reconciliation, legacy device backup reconciliation, OAuth state/PKCE, unauthorized access, refresh-token expiry, same-origin CSRF rejection, atomic GitHub revisions, backup commits, safe retries, and offline/local backup validation.
