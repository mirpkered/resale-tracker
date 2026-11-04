# Resale Tracker

Personal resale inventory and profit tracking. Version 0.3 uses React, TypeScript, and Vite for GitHub Pages, with a private GitHub repository and an explicitly started GitHub Actions workflow for durable storage. This is not a Mirpworks application.

## Storage and security

GitHub Pages serves static browser code. A browser app cannot safely write to a private repository without receiving a credential. This app does not use a PAT, OAuth client secret, GitHub App private key, Supabase, Render, or another backend. The app saves edits in browser local storage and exports a validated revision-based JSON batch. The user uploads that batch to the private data repository and manually starts its workflow. Only after importing the resulting canonical snapshot does the app report that revision as confirmed by GitHub.

The private store is [`mirpkered/resale-tracker-data`](https://github.com/mirpkered/resale-tracker-data). Keep it private and grant access only to the intended account. The repository-scoped Actions `GITHUB_TOKEN` writes data only inside that repository. No credentials or personal financial records are part of the public app repository. Demo/sample data remains in a separate browser workspace and is never included in sync batches; create an empty personal workspace before entering verified records.

### Manual synchronization

1. In the app, go to **Imports → GitHub data sync** and choose **Prepare batch**. The download is a validated `resale-tracker-sync-batch` schema `1.0` document with a stable batch ID, base revision, and integer-cent business records. This step is local only.
2. In the private data repository, upload the file under `incoming/` and commit that upload.
3. Open **Actions → Apply private data batch → Run workflow**; select `apply`, enter the exact `incoming/<filename>.json` path, and run it.
4. After a successful workflow run, download `current/resale-data.v2.json` from the private repository and import it in the app. The app acknowledges a batch only when that remote snapshot's batch history contains its ID.

The same batch is safe to retry. Duplicate IDs with changed content and stale base revisions are rejected. If a revision conflict occurs, import the newest snapshot, compare it with local records, and explicitly resolve the conflict. Before discarding local edits, export a local backup or reconcile them in a separate copy. Offline edits stay in the browser and are never described as committed.

To restore a prior snapshot, run the private workflow with operation `restore`, a file under `backups/`, and the *current* revision. The workflow appends an audit event, preserves import history, backs up the current document, and records restoration as a new revision. `current/resale-data.v2.json` is canonical; `audit/events.ndjson` is an append-only workflow log; Git history also holds prior commits.

The sync uses a JSON file committed to the private repository before the manual workflow dispatch. That permits batches larger than a `workflow_dispatch` text input; the workflow input itself is only the path. Keep each batch reasonably sized because GitHub repository file-size limits still apply.

## Initial setup and local development

Node.js 22 and npm are required.

```sh
git clone https://github.com/mirpkered/resale-tracker.git
cd resale-tracker
npm ci
npm run dev
```

Vite uses `/resale-tracker/` as the production base path. `npm run preview` serves the built app locally. No frontend environment variables or GitHub secrets are required.

## GitHub repositories and deployment

- Public app: [`mirpkered/resale-tracker`](https://github.com/mirpkered/resale-tracker), deployed to <https://mirpkered.github.io/resale-tracker/>.
- Private data: [`mirpkered/resale-tracker-data`](https://github.com/mirpkered/resale-tracker-data), canonical empty document and sync workflow on `main`.

The Pages workflow in `.github/workflows/deploy.yml` installs dependencies, lints, type-checks, tests, builds, and deploys on pushes to `main` (and validates pull requests). In the app repository, ensure **Settings → Pages → Build and deployment → Source** is set to **GitHub Actions**. Do not add private data repository credentials to app repository secrets or variables. There are no credentials to configure for the private workflow; it declares `contents: write` scoped to its own repository.

## Schema and historical migrations

`current/resale-data.v2.json` uses data schema `2.0` and stores lots, inventory, sales, expenses, store credit, platforms, batch hashes, revision numbers, and audit summaries. Monetary values are integer cents. `scripts/data-contract.mjs` validates ownership-internal references, lot allocation bounds, amounts, schema, retries, revision conflicts, and restore behavior. `scripts/sync-data.mjs` stages the canonical snapshot and audit log and commits the changed files together. A failed workflow does not create a Git commit.

The former `supabase/` SQL migrations and RLS test are retained as historical v0.1 reference only. The v0.2 application does not connect to or require Supabase.

## Import, accounting, and migration

Listing conversation imports remain manual and use the app's versioned JSON/CSV preview with stable source IDs and duplicate detection. There is no automatic access to ChatGPT Project conversations.

For historical records, use **Reconciliation** and the empty `public/examples/migration-template.v1.json`. The documented ChatGPT-compatible format is in `public/docs/migration-schema-v1.md`, with a formal JSON Schema at `public/docs/resale-migration.schema.v1.json`. Each imported field carries a verification status; the preview identifies new/imported, existing, conflicting, ambiguous, and unverified values, and shows the before/after financial totals. User changes are preserved unless that record's conflict is explicitly approved. Create a personal workspace first; migration approval changes only local browser data. Then use the separate GitHub sync steps to save the approved records. Production data starts empty; no sample or migration-reference records were inserted. Preserve separate purchase lots (including the Halloween purchase and both Goodwill hauls); optional purchase groups only aggregate reports and never merge costs.

Duplicate inventory quantities retain individual copy IDs, and sale/return records reference those units. Import transaction types distinguish paid cash sales, buyback payouts, store credit, rewards, other expenses, and pending offers. Confirmed cash is reported separately from expected proceeds, and credit/rewards are not cash.

The app continues to use integer cents for money, separates gross sales from confirmed net cash, tracks store credit separately, distinguishes unsold asking value from realized revenue, and reports lot-level and consolidated metrics. Local persistence is not multi-device synchronization; use the manual repository procedure to back up and confirm changes.

## Validation

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

Tests include cents and lot reconciliation, paid/unpaid proceeds, partial and bundled lines, refunds, status transitions, import duplicate previews, storage serialization, demo isolation, revision conflicts, retry idempotency, failed validation recovery, backup restoration, grouped-purchase totals, migration matching, estimated values, pending offers, copy units, and migration financial reconciliation.
