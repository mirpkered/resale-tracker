# Resale Tracker v0.5 — Automatic cloud sync setup

This guide describes the secure automatic-sync architecture and the remaining one-time account setup. The frontend and backend code are implemented, but automatic sync is not operational until a GitHub App is registered, its credentials are stored as Cloudflare Worker secrets, and the Worker-hosted app is used. The public GitHub Pages copy remains a local/manual recovery view because GitHub Pages cannot securely host the OAuth callback or same-origin session cookie.

## Selected architecture

```text
iPhone Safari
   │ same-origin, Secure + HttpOnly session cookie
   ▼
Cloudflare Worker + static assets ── short-lived GitHub App user token ──► private data repo
   │                                                                         │
   └──── Vite React app served at the same Worker origin ◄── canonical JSON ◄┘
```

- **Frontend and API:** one Cloudflare Worker serves the Vite static app and `/api/*`, so Safari treats the session cookie as first party. The Pages URL and a `workers.dev` API would be cross-site; Safari blocks third-party cookies by default. A custom domain shared by the page and API is an alternative.
- **GitHub authorization:** a GitHub App is installed only for `mirpkered/resale-tracker-data`. It needs repository **Contents: Read and write** and implicit **Metadata: Read** access. It does not need the broad OAuth `repo` scope, Actions permissions, or workflow permissions. GitHub Apps have granular permissions and installation-level repository selection; OAuth Apps with `repo` reach all private repos available to the authorizing user. Sign-in uses GitHub App Device Flow so mobile browsers do not need to preserve a cookie across GitHub's cross-site redirect.
- **Sessions:** the Worker displays a short-lived GitHub device code. After approval, it exchanges that code server-side, verifies the GitHub account is `mirpkered` and the target repository is writable, then pins every GitHub request to that repository and its `main` branch. GitHub access and refresh tokens are encrypted with AES-GCM inside a Secure, HttpOnly, SameSite=Lax cookie, set by the same-origin Worker response. Tokens are never returned to app JavaScript or written to localStorage. The authorization-code/PKCE callback remains available at `/api/auth/oauth-start` as a fallback. Worker secrets contain the App client secret and encryption key.
- **Token renewal:** requests use GitHub App user tokens with `offline_access`. GitHub documents an eight-hour access token and a six-month refresh token; refresh rotates both tokens. After refresh expiration or revocation, the app asks the user to sign in again.
- **Writes:** each browser edit is queued locally and saved after a short debounce. The Worker validates the versioned data contract, compares the expected revision, creates the new snapshot and previous-revision backup in one Git tree, fast-forward updates `main`, then reads the canonical file back. The UI reports `Saved` only after that verification. Repeated batch IDs are idempotent. Concurrent writes produce a conflict and preserve local changes.
- **Offline:** edits stay in the existing browser workspace and retry after connectivity returns. They remain marked unsynced until the Worker confirms a write.
- **Private records:** the canonical snapshot stays in the private data repository. Backups and Git history remain in that repository. The app and its public repo never contain financial records or GitHub tokens.

### Cost and service limits

Cloudflare Workers has a no-charge plan with a published 100,000 incoming requests per day limit; GitHub API limits also apply. The app is designed for one account and modest personal inventory, and makes no paid-plan assumption. Check Cloudflare's [current Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [pricing](https://developers.cloudflare.com/workers/platform/pricing/) before expanding usage. GitHub's [GitHub App permission guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app), [user access token guide](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), and [refresh token guide](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens) document the permission and expiry model. WebKit's [tracking prevention documentation](https://webkit.org/tracking-prevention/) documents Safari's third-party cookie restrictions.

## One-time setup

The Worker can be deployed before credentials are added. In this state `/api/health` reports `configured: false`; sign-in and data reads/writes are disabled. No inventory is uploaded or modified.

1. In Cloudflare, create an account if needed and enable its `workers.dev` subdomain. The Worker name in `worker/wrangler.jsonc` is `resale-tracker-private-sync`; after deployment its URL is `https://resale-tracker-private-sync.<your-workers-subdomain>.workers.dev/`.
2. Create a **GitHub App** under your personal account's Developer settings. Set its homepage URL to the Worker URL and its callback URL to `https://resale-tracker-private-sync.<your-workers-subdomain>.workers.dev/api/auth/callback`. Keep expiring user tokens enabled and turn on **Enable Device Flow** under **Identifying and authorizing users**. GitHub documents this toggle in [Modifying a GitHub App registration](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration).
3. Set repository permissions to **Contents: Read and write**; keep Metadata at its default read access. Choose **Only on this account** for installation availability. Install it on **Only select repositories** and select `resale-tracker-data` only. Do not install it on `resale-tracker` unless GitHub requires it for OAuth setup; this app only reads/writes private data.
4. In Cloudflare Worker settings, add encrypted secrets named `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and `SESSION_ENCRYPTION_KEY`. Get the Client ID and generate a new Client Secret in GitHub App settings. For the encryption key, use a password manager's random generator with at least 48 random characters, or create 32 random bytes encoded as base64. Never reuse a GitHub credential as the encryption key.
5. Open `https://<worker-url>/api/health`. Confirm it reports `configured: true`. Then open the Worker app on the iPhone and choose **Sign in with GitHub**. Tap **Create a GitHub sign-in code**, open GitHub's device authorization page, enter the displayed one-time code, and approve the app. Return to the Resale Tracker tab and tap **Check authorization**. GitHub's [device flow guide](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token) describes the approval steps. The Worker verifies the account and repository access before creating a session.
6. Set up future deployments from GitHub Actions: create a Cloudflare API token scoped to this Worker with the minimum Workers **Editor** role; add it as the app repository Actions secret `CLOUDFLARE_API_TOKEN`. Add `CLOUDFLARE_ACCOUNT_ID` as a repository variable and `CLOUDFLARE_DEPLOY_ENABLED=true` as a variable. The workflow `.github/workflows/deploy-worker.yml` tests every change and deploys only after this flag is enabled. Cloudflare documents the [GitHub Actions token setup](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) and [Worker role scopes](https://developers.cloudflare.com/workers/authorization/workers/).

Client ID/secret and session key belong in Cloudflare's Worker secret store, not GitHub Actions, the browser, or source code. Only the narrowly scoped deployment token belongs in GitHub Actions secrets.

## Preserve and move the existing iPhone workspace

Browser storage is isolated by origin. The GitHub Pages origin cannot be read by the Worker origin, and the app does not attempt to copy it through JavaScript or a URL. This one-time move requires a private backup file; normal edits and imports after setup sync automatically.

1. On the current GitHub Pages app on the iPhone, open **Imports → Advanced backup and manual GitHub recovery → Download backup**. This exports the personal workspace to a JSON file on the device. Demo data is rejected by the exporter. Keep this backup private; do not upload it to ChatGPT, commit it to GitHub, or send it to a public service.
2. Open the Worker URL in Safari and sign in. Create a **Personal workspace** if this new origin starts in demo mode. Demo records remain separate and are never included in a migration.
3. Choose **Review device backup**, select the backup file, and inspect the reconciliation. It previews additions, exact matches, possible duplicates, changed IDs, purchase investment, available quantities, asking value, confirmed cash, and realized profit. Resolve every conflict explicitly.
4. Press **Approve merge & save to GitHub**. The app rechecks the cloud revision, merges records by stable IDs, commits a new revision and backup, and verifies the canonical snapshot. Reload the Worker app and confirm its revision and records before removing the downloaded backup.

Compare the preview with the existing source workspace and supporting records before approving. Check the original purchase, remaining and disposed quantities, item-level details, and all recorded proceeds. The app never synthesizes records. If expected records are absent from the backup, stop and reconcile the source workspace before approving.

The private repository currently remains unchanged by this setup work. Its canonical revision is checked live during sign-in and again before every write. Never replace revision 0 with a local snapshot without reviewing the merge preview.

## Recovery and limits

- **Saved** means the Worker committed the revision and confirmed its canonical file. **Unsynced**, **Offline**, **Sync failed**, and **Conflict** never mean cloud persistence.
- On revision conflict, local edits remain in local storage. Use the merge review to reconcile with the newest cloud revision; do not force a write.
- The previous snapshot is saved under `backups/` in the same Git commit as the current snapshot update. Repository history remains available for recovery.
- A GitHub authorization lasts about eight hours per access token and can be renewed for up to six months with the refresh token. After that, sign in again.
- The existing `https://mirpkered.github.io/resale-tracker/` URL cannot provide this cookie-backed auth flow. It remains an unconnected frontend and manual recovery path. Use the Worker URL as the daily app, or later set a custom domain that serves the Worker on the desired domain.
- The Worker backend has unit and mocked GitHub API coverage but awaits real GitHub App credentials. Automatic sign-in/read/write/reload is **not verified or operational** until setup and an authenticated end-to-end check complete.
