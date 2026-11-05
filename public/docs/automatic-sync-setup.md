# Resale Tracker v0.6.1 — Automatic cloud sync and iPhone installation

The Cloudflare Worker and GitHub App are configured for the private `mirpkered/resale-tracker-data` repository. Open the Worker app for authenticated inventory and automatic sync. GitHub Pages cannot securely host this cookie-backed authentication flow and is a recovery frontend that links to the Worker.

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

## Authentication and first launch

1. Open `https://resale-tracker-private-sync.mirpkered.workers.dev/`. If signed out, choose **Sign in with GitHub**, approve the one-time Device Flow code, and return to the app. The app checks the account and reads the canonical snapshot before displaying inventory.
2. On an iPhone, if the existing green-basket home-screen icon opens a stale or Pages version, remove that shortcut. Open the Worker URL above in the browser, sign in, then use the browser's **Add to Home Screen** action. The installed app will launch from the Worker origin. iOS standalone storage and cookies can be separate from a browser tab, so sign in within the installed app if prompted.
3. Empty local storage is never uploaded automatically over a cloud snapshot. The app loads the canonical revision first; if a previously used local workspace has changes, it asks for an explicit reconciliation.
4. For future deployments, the existing workflow `.github/workflows/deploy-worker.yml` uses the configured Cloudflare GitHub Actions token and variables. Keep GitHub App credentials in encrypted Worker secrets only.

Client ID/secret and session key belong in Cloudflare's Worker secret store, not GitHub Actions, the browser, or source code. Only the narrowly scoped deployment token belongs in GitHub Actions secrets.

## GitHub Pages recovery copy

Browser storage is isolated by origin. The Pages origin cannot read Worker local storage. The private GitHub repository is canonical; normal authenticated use loads from that cloud snapshot, not from Pages local storage.

1. Open the GitHub Pages app, then use its sign-in recovery link to open the Worker. Pages does not hold or migrate private inventory automatically.
2. If you have an older device backup that is not in the private repository, sign in to the Worker and use **Imports → Review device backup**. Inspect all matching records and financial changes before approving.
3. The Worker rechecks the revision, creates a backup, and verifies the committed canonical snapshot before showing Saved.

Compare the preview with the existing source workspace and supporting records before approving. Check the original purchase, remaining and disposed quantities, item-level details, and all recorded proceeds. The app never synthesizes records. If expected records are absent from the backup, stop and reconcile the source workspace before approving.

The private repository currently remains unchanged by this setup work. Its canonical revision is checked live during sign-in and again before every write. Never replace revision 0 with a local snapshot without reviewing the merge preview.

## Recovery and limits

- **Saved** means the Worker committed the revision and confirmed its canonical file. **Unsynced**, **Offline**, **Sync failed**, and **Conflict** never mean cloud persistence.
- On revision conflict, local edits remain in local storage. Use the merge review to reconcile with the newest cloud revision; do not force a write.
- The previous snapshot is saved under `backups/` in the same Git commit as the current snapshot update. Repository history remains available for recovery.
- A GitHub authorization lasts about eight hours per access token and can be renewed for up to six months with the refresh token. After that, sign in again.
- The existing `https://mirpkered.github.io/resale-tracker/` URL cannot provide this cookie-backed auth flow. It remains an unconnected frontend and manual recovery path. Use the Worker URL as the daily app, or later set a custom domain that serves the Worker on the desired domain.
- iPhone home-screen installs use the Worker origin. If GitHub authorization has expired, sign in again from that installed app; never rely on a Chrome tab's local storage or cookie being shared.
