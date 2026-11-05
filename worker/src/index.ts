import { applyBatch, validateDocument, type StoredDocument, type SyncBatch } from '../../scripts/data-contract.mjs'

type RuntimeEnv = Env & { GITHUB_APP_CLIENT_ID: string; GITHUB_APP_CLIENT_SECRET: string; SESSION_ENCRYPTION_KEY: string }

const COOKIE = 'rt_github_session'
const STATE_COOKIE = 'rt_oauth_state'
const SNAPSHOT = 'current/resale-data.v2.json'
const MAX_SNAPSHOT_BYTES = 900_000
const API_VERSION = '2026-03-10'
type AuthSession = { login: string; accessToken: string; refreshToken: string; accessExpiresAt: number; refreshExpiresAt: number }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
    const config = env as RuntimeEnv
    let rotatedCookie: string | undefined
    try {
      if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true, automaticSync: isConfigured(config), configured: isConfigured(config) })
      if (['/api/auth/start', '/api/auth/login', '/api/auth/oauth-start', '/api/auth/callback', '/api/auth/device/start', '/api/auth/device/poll', '/api/auth/sign-out', '/api/session', '/api/data'].includes(url.pathname) && !isConfigured(config)) return json({ error: 'sync_not_configured', message: 'Automatic GitHub sync requires GitHub App credentials and a session encryption key.' }, 503)
      if (['/api/auth/start', '/api/auth/login'].includes(url.pathname) && request.method === 'GET') return deviceSignInPage()
      if (url.pathname === '/api/auth/device/start' && request.method === 'POST') return await startDeviceFlow(request, config)
      if (url.pathname === '/api/auth/device/poll' && request.method === 'POST') return await pollDeviceFlow(request, config)
      if (url.pathname === '/api/auth/oauth-start' && request.method === 'GET') return await startOAuth(request, config)
      if (url.pathname === '/api/auth/callback' && request.method === 'GET') return await finishOAuth(request, config)
      if (url.pathname === '/api/auth/sign-out' && request.method === 'POST') { assertSameOrigin(request); return clearSession() }
      if (url.pathname === '/api/session' && request.method === 'GET') {
        const { session, cookie } = await getSession(request, config); rotatedCookie = cookie
        return json({ authenticated: true, login: session.login, expiresAt: session.accessExpiresAt }, 200, cookie)
      }
      if (url.pathname === '/api/data' && request.method === 'GET') {
        const { session, cookie } = await getSession(request, config); rotatedCookie = cookie
        const remote = await getCanonical(config, session.accessToken)
        return json({ document: remote.document, etag: remote.commitSha, syncConfirmedAt: remote.document.updatedAt }, 200, cookie)
      }
      if (url.pathname === '/api/data' && request.method === 'PUT') {
        assertSameOrigin(request)
        const { session, cookie } = await getSession(request, config); rotatedCookie = cookie
        const input = await readJsonLimited<{ batch?: SyncBatch }>(request, MAX_SNAPSHOT_BYTES)
        if (!input.batch || input.batch.format !== 'resale-tracker-sync-batch') return json({ error: 'invalid_batch' }, 400, cookie)
        const result = await commitBatch(config, session, input.batch)
        return json({ document: result.document, duplicate: result.duplicate, commitSha: result.commitSha, syncConfirmedAt: result.document.updatedAt }, 200, cookie)
      }
      return json({ error: 'not_found' }, 404)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      const status = message.startsWith('Unauthorized') ? 401 : message.startsWith('Forbidden') ? 403 : message.startsWith('Revision conflict') ? 409 : message.startsWith('Invalid') ? 400 : 502
      console.error(JSON.stringify({ event: 'sync_request_failed', route: url.pathname, status, reason: message.slice(0, 160) }))
      return json({ error: status === 409 ? 'revision_conflict' : status === 401 ? 'reauthorization_required' : 'sync_failed', message }, status, rotatedCookie)
    }
  },
} satisfies ExportedHandler<Env>

async function startOAuth(request: Request, env: RuntimeEnv): Promise<Response> {
  const origin = new URL(request.url).origin
  const state = randomToken(24), verifier = randomToken(48)
  const cookie = await seal({ state, verifier }, env.SESSION_ENCRYPTION_KEY)
  const target = new URL('https://github.com/login/oauth/authorize')
  target.searchParams.set('client_id', env.GITHUB_APP_CLIENT_ID)
  target.searchParams.set('redirect_uri', `${origin}/api/auth/callback`)
  target.searchParams.set('state', state)
  target.searchParams.set('scope', 'offline_access')
  target.searchParams.set('code_challenge', await challenge(verifier))
  target.searchParams.set('code_challenge_method', 'S256')
  const headers = new Headers({ Location: target.toString(), 'Cache-Control': 'no-store' })
  // This temporary state cookie must survive GitHub's cross-site redirect back to the Worker.
  // The callback still verifies the unpredictable state value and encrypted PKCE verifier.
  headers.append('Set-Cookie', `${STATE_COOKIE}=${cookie}; Path=/; Max-Age=1800; HttpOnly; Secure; SameSite=None`)
  return new Response(null, { status: 302, headers })
}

function deviceSignInPage(): Response {
  const nonce = randomToken(18)
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Connect Resale Tracker</title><style nonce="${nonce}">:root{font:16px system-ui,sans-serif;color-scheme:light dark}body{margin:0;background:#111827;color:#f8fafc;min-height:100vh;display:grid;place-items:center;padding:20px;box-sizing:border-box}.card{width:min(100%,440px);background:#1f2937;border:1px solid #374151;border-radius:20px;padding:24px;box-sizing:border-box}h1{font-size:1.5rem;margin:0 0 10px}p{color:#d1d5db;line-height:1.5}.button,a.button{display:flex;justify-content:center;align-items:center;min-height:50px;padding:0 16px;border:0;border-radius:12px;background:#2563eb;color:white;font:inherit;font-weight:700;text-decoration:none;box-sizing:border-box;width:100%;margin:12px 0}button:disabled{opacity:.5}.code{font-size:2rem;letter-spacing:.14em;font-weight:800;text-align:center;padding:14px;border:1px dashed #9ca3af;border-radius:12px}.hint{font-size:.9rem}.error{color:#fca5a5;min-height:1.5em}#steps[hidden],#codebox[hidden]{display:none}</style></head><body><main class="card"><h1>Connect Resale Tracker to GitHub</h1><p>This code-based sign-in avoids the browser redirect cookie issue. Your GitHub access token stays on the secure Worker.</p><button id="begin" class="button">Create a GitHub sign-in code</button><section id="steps" hidden><p>1. Open GitHub and enter this one-time code:</p><div id="usercode" class="code"></div><a class="button" href="https://github.com/login/device" target="_blank" rel="noopener noreferrer">Open GitHub device authorization</a><p class="hint">2. Approve Resale Tracker, then return here. This code expires in 15 minutes.</p><button id="check" class="button">Check authorization</button><button id="restart" class="button" hidden>Start a new sign-in</button></section><p id="message" role="status" aria-live="polite"></p><p id="error" class="error" role="alert"></p></main><script nonce="${nonce}">(function(){const begin=document.getElementById('begin'),steps=document.getElementById('steps'),usercode=document.getElementById('usercode'),check=document.getElementById('check'),restart=document.getElementById('restart'),message=document.getElementById('message'),error=document.getElementById('error');let deviceCode='',interval=5,lastPoll=0;function reset(){deviceCode='';interval=5;lastPoll=0;steps.hidden=true;begin.hidden=false;begin.disabled=false;restart.hidden=true;message.textContent='';error.textContent=''}restart.addEventListener('click',reset);function post(path,body){return fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Resale-Request':'1'},body:JSON.stringify(body||{})})}begin.addEventListener('click',async()=>{begin.disabled=true;error.textContent='';message.textContent='Requesting a one-time code…';try{const r=await post('/api/auth/device/start');const d=await r.json();if(!r.ok)throw new Error(d.message||'Could not start GitHub authorization.');deviceCode=d.deviceCode;interval=Math.max(5,Number(d.interval)||5);usercode.textContent=d.userCode;steps.hidden=false;begin.hidden=true;message.textContent='Waiting for approval in GitHub.';lastPoll=0}catch(e){error.textContent=e instanceof Error?e.message:'Could not start sign-in.';begin.disabled=false;message.textContent=''}});check.addEventListener('click',async()=>{if(!deviceCode)return;const wait=interval*1000-(Date.now()-lastPoll);if(wait>0){message.textContent='Please wait '+Math.ceil(wait/1000)+' seconds before checking again.';return}check.disabled=true;error.textContent='';message.textContent='Checking GitHub authorization…';lastPoll=Date.now();try{const r=await post('/api/auth/device/poll',{deviceCode,interval});const d=await r.json();if(r.status===202){if(d.interval)interval=Math.max(interval,Number(d.interval));message.textContent='Not approved yet. Approve in GitHub, then check again.';return}if(!r.ok)throw new Error(d.message||'GitHub authorization failed.');message.textContent='Connected. Loading your private inventory…';window.location.replace('/')}catch(e){error.textContent=e instanceof Error?e.message:'Could not check authorization.';restart.hidden=false;message.textContent=''}finally{check.disabled=false}})})();</script></body></html>`
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` } })
}

async function startDeviceFlow(request: Request, env: RuntimeEnv): Promise<Response> {
  assertSameOrigin(request)
  const form = new URLSearchParams({ client_id: env.GITHUB_APP_CLIENT_ID, scope: 'offline_access' })
  const response = await fetch('https://github.com/login/device/code', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() })
  const result = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok || typeof result?.device_code !== 'string' || typeof result.user_code !== 'string') {
    const code = typeof result?.error === 'string' && /^[a-z0-9_]+$/i.test(result.error) ? result.error : `http_${response.status}`
    throw new Error(`GitHub device authorization could not start (${code}). Enable Device Flow in the GitHub App settings, then retry.`)
  }
  return json({ deviceCode: result.device_code, userCode: result.user_code, verificationUri: 'https://github.com/login/device', expiresIn: result.expires_in, interval: result.interval })
}

async function pollDeviceFlow(request: Request, env: RuntimeEnv): Promise<Response> {
  assertSameOrigin(request)
  const input = await readJsonLimited<{ deviceCode?: unknown; interval?: unknown }>(request, 4096)
  if (typeof input.deviceCode !== 'string' || !/^[A-Za-z0-9._-]{30,200}$/.test(input.deviceCode)) return json({ error: 'invalid_device_code', message: 'The GitHub sign-in code is invalid. Start again.' }, 400)
  const interval = typeof input.interval === 'number' && Number.isFinite(input.interval) ? Math.max(1, Math.min(Math.floor(input.interval), 60)) : 5
  const form = new URLSearchParams({ client_id: env.GITHUB_APP_CLIENT_ID, device_code: input.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
  const response = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() })
  const token = await response.json().catch(() => null) as Record<string, unknown> | null
  if (token?.error === 'authorization_pending') return json({ status: 'pending' }, 202)
  if (token?.error === 'slow_down') {
    const nextInterval = typeof token.interval === 'number' && Number.isFinite(token.interval) ? Math.max(interval + 5, Math.min(Math.floor(token.interval), 60)) : interval + 5
    console.warn(JSON.stringify({ event: 'github_device_flow_slow_down', interval, nextInterval }))
    return json({ status: 'pending', interval: nextInterval }, 202)
  }
  if (token?.error) {
    const code = typeof token.error === 'string' && /^[a-z0-9_]+$/i.test(token.error) ? token.error : 'authorization_failed'
    const expired = code === 'expired_token' || code === 'token_expired'
    const status = code === 'access_denied' ? 403 : expired ? 410 : 400
    console.warn(JSON.stringify({ event: 'github_device_flow_rejected', code, status }))
    return json({ error: code, message: expired ? 'The GitHub sign-in code expired. Start again.' : code === 'access_denied' ? 'GitHub authorization was denied. Start again when ready.' : `GitHub authorization could not be completed (${code}).` }, status)
  }
  if (!response.ok || typeof token?.access_token !== 'string' || typeof token.refresh_token !== 'string') {
    const providerCode = typeof token?.error === 'string' && /^[a-z0-9_]+$/i.test(token.error) ? token.error : undefined
    const requestId = response.headers.get('x-github-request-id')?.replace(/[^A-Za-z0-9:-]/g, '').slice(0, 40)
    console.error(JSON.stringify({ event: 'github_device_token_exchange_failed', upstreamStatus: response.status, providerCode, requestId, contentType: response.headers.get('content-type')?.slice(0, 80) }))
    if (!response.ok) return json({ error: 'token_exchange_failed', message: `GitHub token endpoint returned HTTP ${response.status}${providerCode ? ` (${providerCode})` : ''}${requestId ? ` (request ${requestId})` : ''}. No session was created; start a new sign-in code and retry.` }, 502)
    return json({ error: 'token_exchange_failed', message: 'GitHub returned HTTP 200 without the required expiring access and refresh tokens. Check that offline_access is enabled for this app, then start a new sign-in code.' }, 502)
  }
  const authorized = await establishSession(token as { access_token: string; refresh_token: string; expires_in?: number; refresh_token_expires_in?: number }, env)
  return json({ authenticated: true, login: authorized.login, expiresAt: authorized.expiresAt }, 200, authorized.cookie)
}

async function finishOAuth(request: Request, env: RuntimeEnv): Promise<Response> {
  const url = new URL(request.url), code = url.searchParams.get('code'), state = url.searchParams.get('state')
  const stateCookie = readCookie(request, STATE_COOKIE)
  if (url.searchParams.has('error')) return new Response('GitHub authorization was denied or cancelled. No session was created. Return to Resale Tracker and start sign-in again.', { status: 400 })
  if (!code || !state) return new Response('GitHub returned to the callback without the required authorization code or state. Restart sign-in from Resale Tracker.', { status: 400 })
  if (!stateCookie) return new Response('The browser did not return the temporary sign-in cookie. Restart sign-in in the same browser and allow cookies for this site.', { status: 400 })
  let expected: { state: string; verifier: string }
  try { expected = await unseal<{ state: string; verifier: string }>(stateCookie, env.SESSION_ENCRYPTION_KEY) } catch { return new Response('GitHub sign-in could not be verified. Restart sign-in.', { status: 400 }) }
  if (!constantTimeEqual(state, expected.state)) return new Response('GitHub sign-in could not be verified. Restart sign-in.', { status: 400 })
  const token = await tokenRequest(new URLSearchParams({ client_id: env.GITHUB_APP_CLIENT_ID, client_secret: env.GITHUB_APP_CLIENT_SECRET, code, redirect_uri: `${url.origin}/api/auth/callback`, code_verifier: expected.verifier }), 'authorization_code')
  const authorized = await establishSession(token, env)
  const headers = new Headers({ Location: `${url.origin}/`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
  headers.append('Set-Cookie', authorized.cookie)
  headers.append('Set-Cookie', `${STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None`)
  return new Response(null, { status: 302, headers })
}

async function establishSession(token: { access_token: string; refresh_token: string; expires_in?: number; refresh_token_expires_in?: number }, env: RuntimeEnv) {
  const user = await githubApi<{ login: string }>('/user', token.access_token)
  if (user.login !== env.GITHUB_ALLOWED_LOGIN) throw new Error('Forbidden: this GitHub account is not authorized for this personal tracker.')
  const repository = await githubApi<{ full_name?: string; permissions?: { push?: boolean } }>(`/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}`, token.access_token)
  if (repository.full_name?.toLowerCase() !== `${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}`.toLowerCase() || repository.permissions?.push !== true) throw new Error('Forbidden: the GitHub App must have read/write access to the private data repository for this account.')
  const expiresAt = Date.now() + Number(token.expires_in ?? 28_800) * 1000
  const refreshExpiresAt = Date.now() + Number(token.refresh_token_expires_in ?? 15_897_600) * 1000
  const session: AuthSession = { login: user.login, accessToken: token.access_token, refreshToken: token.refresh_token, accessExpiresAt: expiresAt, refreshExpiresAt }
  const sealed = await seal(session, env.SESSION_ENCRYPTION_KEY)
  return { login: user.login, expiresAt, cookie: `${COOKIE}=${sealed}; Path=/; Max-Age=${Math.floor((refreshExpiresAt - Date.now()) / 1000)}; HttpOnly; Secure; SameSite=Lax` }
}

async function getSession(request: Request, env: RuntimeEnv): Promise<{ session: AuthSession; cookie?: string }> {
  const value = readCookie(request, COOKIE)
  if (!value) throw new Error('Unauthorized: sign in with GitHub.')
  let session: AuthSession
  try { session = await unseal<AuthSession>(value, env.SESSION_ENCRYPTION_KEY) } catch { throw new Error('Unauthorized: session expired; sign in again.') }
  if (session.login.toLowerCase() !== env.GITHUB_ALLOWED_LOGIN.toLowerCase()) throw new Error('Unauthorized: this account is not allowed.')
  if (session.accessExpiresAt > Date.now() + 60_000) return { session }
  if (session.refreshExpiresAt <= Date.now()) throw new Error('Unauthorized: GitHub authorization expired; sign in again.')
  const refreshed = await tokenRequest(new URLSearchParams({ client_id: env.GITHUB_APP_CLIENT_ID, client_secret: env.GITHUB_APP_CLIENT_SECRET, refresh_token: session.refreshToken }), 'refresh_token')
  session = { ...session, accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token, accessExpiresAt: Date.now() + Number(refreshed.expires_in) * 1000, refreshExpiresAt: Date.now() + Number(refreshed.refresh_token_expires_in) * 1000 }
  const cookie = `${COOKIE}=${await seal(session, env.SESSION_ENCRYPTION_KEY)}; Path=/; Max-Age=${Math.floor((session.refreshExpiresAt - Date.now()) / 1000)}; HttpOnly; Secure; SameSite=Lax`
  return { session, cookie }
}

async function getCanonical(env: Env, token: string): Promise<{ document: StoredDocument; commitSha: string; snapshotSha: string; treeSha: string }> {
  const ref = await githubApi<{ object: { sha: string } }>(`/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/git/ref/heads/${env.GITHUB_REPO_BRANCH}`, token)
  const commit = await githubApi<{ tree: { sha: string } }>(`/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/git/commits/${ref.object.sha}`, token)
  const tree = await githubApi<{ tree: Array<{ path: string; sha: string }> }>(`/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/git/trees/${commit.tree.sha}?recursive=1`, token)
  const file = tree.tree.find((entry) => entry.path === SNAPSHOT)
  if (!file) throw new Error('Invalid private data repository: canonical snapshot file is missing.')
  const blob = await githubApi<{ content: string }>(`/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/git/blobs/${file.sha}`, token)
  const text = decodeBase64(blob.content)
  if (new TextEncoder().encode(text).length > MAX_SNAPSHOT_BYTES) throw new Error('Invalid canonical snapshot: exceeds supported size.')
  const document = JSON.parse(text) as StoredDocument
  validateDocument(document)
  return { document, commitSha: ref.object.sha, snapshotSha: file.sha, treeSha: commit.tree.sha }
}

async function commitBatch(env: Env, session: AuthSession, batch: SyncBatch) {
  const current = await getCanonical(env, session.accessToken)
  const result = applyBatch(current.document, batch, { actor: session.login })
  if (result.duplicate) return { document: current.document, duplicate: true, commitSha: current.commitSha }
  const content = JSON.stringify(result.document, null, 2) + '\n'
  if (new TextEncoder().encode(content).length > MAX_SNAPSHOT_BYTES) throw new Error('Invalid proposed snapshot: exceeds supported size.')
  const root = `/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}`
  const blob = await githubApi<{ sha: string }>(`${root}/git/blobs`, session.accessToken, { method: 'POST', body: JSON.stringify({ content, encoding: 'utf-8' }) })
  const backupPath = `backups/r${current.document.revision}-${batch.batchId}.json`
  const tree = await githubApi<{ sha: string }>(`${root}/git/trees`, session.accessToken, { method: 'POST', body: JSON.stringify({ base_tree: current.treeSha, tree: [
    { path: SNAPSHOT, mode: '100644', type: 'blob', sha: blob.sha },
    { path: backupPath, mode: '100644', type: 'blob', sha: current.snapshotSha },
  ] }) })
  const commit = await githubApi<{ sha: string }>(`${root}/git/commits`, session.accessToken, { method: 'POST', body: JSON.stringify({ message: `Save Resale Tracker revision ${result.document.revision}`, tree: tree.sha, parents: [current.commitSha] }) })
  try {
    await githubApi(`${root}/git/refs/heads/${env.GITHUB_REPO_BRANCH}`, session.accessToken, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) })
  } catch (error) {
    const latest = await getCanonical(env, session.accessToken)
    const applied = latest.document.importedBatches.find((entry) => entry.batchId === batch.batchId)
    if (applied?.sha256 === result.hash) return { document: latest.document, duplicate: true, commitSha: latest.commitSha }
    if (latest.document.revision !== batch.baseRevision) throw new Error('Revision conflict: another device updated private data while this save was in progress. Local changes are preserved; reload and reconcile.')
    throw new Error(`GitHub write was not confirmed (${error instanceof Error ? error.message : 'network failure'}). Retry is safe with the same batch ID.`)
  }
  const confirmed = await getCanonical(env, session.accessToken)
  if (confirmed.commitSha !== commit.sha || confirmed.document.lastBatchId !== batch.batchId) throw new Error('Revision conflict: the write was replaced before confirmation. Local changes are preserved.')
  return { document: confirmed.document, duplicate: false, commitSha: confirmed.commitSha }
}

async function githubApi<T extends object>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, { ...init, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'ResaleTracker/0.5', 'X-GitHub-Api-Version': API_VERSION, 'Content-Type': 'application/json', ...init.headers } })
  if (!response.ok) {
    if (response.status === 401) throw new Error('Unauthorized: GitHub access expired; sign in again.')
    if (response.status === 409 || response.status === 422) throw new Error(`Revision conflict: GitHub rejected a stale write (${response.status}). Reload and reconcile.`)
    const errorBody = await response.json().catch(() => null) as { message?: unknown; errors?: unknown } | null
    const providerMessage = typeof errorBody?.message === 'string'
      ? errorBody.message.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 180)
      : undefined
    const requestId = response.headers.get('x-github-request-id')?.replace(/[^A-Za-z0-9:-]/g, '').slice(0, 40)
    const details = [providerMessage, requestId ? `GitHub request ${requestId}` : undefined].filter(Boolean).join(' ')
    throw new Error(`GitHub repository request failed at ${init.method ?? 'GET'} ${path} (${response.status})${details ? `: ${details}` : '.'}`)
  }
  return response.json() as Promise<T>
}

async function readJsonLimited<T>(request: Request, maxBytes: number): Promise<T> {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('Invalid request: JSON body is required.')
  const parts: Uint8Array[] = []; let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) { await reader.cancel(); throw new Error('Invalid request: payload exceeds the supported size.') }
    parts.push(value)
  }
  const bytes = new Uint8Array(total); let offset = 0
  for (const part of parts) { bytes.set(part, offset); offset += part.length }
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}

async function tokenRequest(body: URLSearchParams, grantType: 'authorization_code' | 'refresh_token') {
  if (grantType === 'refresh_token') body.set('grant_type', 'refresh_token')
  const response = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() })
  const token = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) {
    const code = typeof token?.error === 'string' && /^[a-z0-9_]+$/i.test(token.error) ? token.error : `http_${response.status}`
    throw new Error(`Unauthorized: GitHub token exchange failed (${code}). Sign in again.`)
  }
  if (typeof token?.access_token !== 'string') throw new Error('Unauthorized: GitHub token response is missing an access token.')
  if (typeof token.refresh_token !== 'string') throw new Error('Unauthorized: GitHub token response is missing a refresh token. Confirm the offline_access request or expiring user access token setting.')
  return token as { access_token: string; refresh_token: string; expires_in?: number; refresh_token_expires_in?: number }
}

function assertSameOrigin(request: Request) {
  const origin = request.headers.get('origin')
  if (!origin || origin !== new URL(request.url).origin || request.headers.get('x-resale-request') !== '1') throw new Error('Unauthorized: invalid request origin.')
}
function isConfigured(env: RuntimeEnv) { return Boolean(env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET && env.SESSION_ENCRYPTION_KEY && new TextEncoder().encode(env.SESSION_ENCRYPTION_KEY).length >= 32) }
function readCookie(request: Request, name: string) { return request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) }
function json(value: unknown, status = 200, cookie?: string) { const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" }); if (cookie) headers.append('Set-Cookie', cookie); return new Response(JSON.stringify(value), { status, headers }) }
function clearSession() { return new Response(JSON.stringify({ signedOut: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } }) }
function randomToken(bytes: number) { const value = crypto.getRandomValues(new Uint8Array(bytes)); return btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') }
async function challenge(verifier: string) { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)); return btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') }
async function seal(value: unknown, encodedKey: string) { const key = await getKey(encodedKey), iv = crypto.getRandomValues(new Uint8Array(12)), cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value))); return btoa(String.fromCharCode(...new Uint8Array(iv), ...new Uint8Array(cipher))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') }
export async function sealWorkerSession(value: unknown, encodedKey: string) { return seal(value, encodedKey) }
async function unseal<T>(token: string, encodedKey: string): Promise<T> { const base64 = token.replaceAll('-', '+').replaceAll('_', '/'), padded = base64 + '='.repeat((4 - base64.length % 4) % 4), bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)), iv = bytes.slice(0, 12), cipher = bytes.slice(12), clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await getKey(encodedKey), cipher); return JSON.parse(new TextDecoder().decode(clear)) as T }
async function getKey(encoded: string) { let raw = new TextEncoder().encode(encoded); try { const candidate = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)); if (candidate.length === 32) raw = candidate } catch { /* High-entropy random text is also supported and hashed to an AES-256 key. */ } if (raw.length < 32) throw new Error('Invalid worker session configuration.'); const key = raw.length === 32 ? raw : new Uint8Array(await crypto.subtle.digest('SHA-256', raw)); return crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']) }
function decodeBase64(content: string) { const binary = atob(content.replaceAll('\n', '')); return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0))) }
function constantTimeEqual(left: string, right: string) { const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right); let diff = a.length ^ b.length; for (let index = 0; index < Math.max(a.length, b.length); index++) diff |= (a[index] ?? 0) ^ (b[index] ?? 0); return diff === 0 }
