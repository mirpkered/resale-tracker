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

## Import, accounting, and migration (v0.4)

The dedicated [ChatGPT import guide](public/docs/chatgpt-import-guide.md) documents the current `resale-tracker-migration` schema version `1.0`, stable ID rules, every supported field, verification statuses, and a full format example. The [formal JSON Schema](public/docs/resale-migration.schema.v1.json) is linked in the guide. The [downloadable template](public/examples/migration-template.v1.json) is empty and does not contain user records. ChatGPT Project access remains manual; the app does not read conversations automatically.

Use **Reconciliation** to preview new and existing rows, possible duplicates, conflicts, missing/unverified fields, inventory quantity, purchase investment, confirmed asking value, confirmed cash, expected future proceeds, and realized profit. The preview does not write private GitHub storage. Stable IDs make repeated imports idempotent; changed values require per-record conflict approval and a separate import confirmation. User-edited fields remain until that conflict is explicitly approved.

Purchase groups are reporting labels. Goodwill Outlet/Bins purchases on November 1 ($54.78) and November 4 ($45.37) remain two purchase lots with a $100.15 combined reporting total. The October 31 Halloween DVD purchase ($23.00) remains separate, with only confirmed inventory imported. Joan of Arcadia Season 2 is unsold inventory; exclude the unverified Joan sale/pending transaction and $3.50 amount. The Japanese DS/3DS lot's approximately $25 cost is estimated until confirmed; represent its 67 DS and 3 3DS cartridges as separate copies. Keep generated listing text and Vinted prices as suggestions until a listing is confirmed active. These are migration reference notes only; nothing is preloaded.

A `cash_sale` transaction may link item external IDs and their quantities. On first import, it reduces available stock, links individual unit IDs, allocates net proceeds and acquisition cost, and contributes realized profit only for confirmed payment and confirmed item cost. Stable transaction IDs prevent replay from reducing stock twice. Do not change the quantities on a previously imported sale in a later batch: record the return or inventory adjustment first. Asking prices and offers never count as sale revenue. Store credit and rewards stay separate from cash.

Manual item editing covers descriptions, purchase lot, quantity, allocated cost, asking prices, platform, listing state, and notes. Sales and imported financial transactions can be edited in the app; changing gross, fees, shipping, expenses, or payment status recalculates confirmed cash and profit. Each local write adds a bounded audit entry that travels with the next GitHub snapshot. GitHub synchronization remains the existing manual workflow: prepare a batch, upload it to the private data repository, run the Actions workflow, and import the confirmed canonical snapshot.

No sample inventory is seeded into the personal workspace or private data repository. The demo workspace remains separate.

## Validation

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

Tests include cents and lot reconciliation, paid/unpaid proceeds, partial and bundled lines, refunds, status transitions, import duplicate previews, storage serialization, demo isolation, revision conflicts, retry idempotency, failed validation recovery, backup restoration, grouped-purchase totals, migration matching, estimated values, pending offers, copy units, partial imported cash sales, repeat imports, and migration financial reconciliation.
