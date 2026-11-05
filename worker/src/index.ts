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
      if (['/api/auth/start', '/api/auth/login', '/api/auth/callback', '/api/auth/sign-out', '/api/session', '/api/data'].includes(url.pathname) && !isConfigured(config)) return json({ error: 'sync_not_configured', message: 'Automatic GitHub sync requires GitHub App credentials and a session encryption key.' }, 503)
      if (['/api/auth/start', '/api/auth/login'].includes(url.pathname) && request.method === 'GET') return await startOAuth(request, config)
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
      const status = message.startsWith('Unauthorized') ? 401 : message.startsWith('Revision conflict') ? 409 : message.startsWith('Invalid') ? 400 : 502
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
  headers.append('Set-Cookie', `${STATE_COOKIE}=${cookie}; Path=/api/auth/callback; Max-Age=600; HttpOnly; Secure; SameSite=Lax`)
  return new Response(null, { status: 302, headers })
}

async function finishOAuth(request: Request, env: RuntimeEnv): Promise<Response> {
  const url = new URL(request.url), code = url.searchParams.get('code'), state = url.searchParams.get('state')
  const stateCookie = readCookie(request, STATE_COOKIE)
  if (!code || !state || !stateCookie) return new Response('GitHub sign-in was cancelled. Return to Resale Tracker and try again.', { status: 400 })
  let expected: { state: string; verifier: string }
  try { expected = await unseal<{ state: string; verifier: string }>(stateCookie, env.SESSION_ENCRYPTION_KEY) } catch { return new Response('GitHub sign-in could not be verified. Restart sign-in.', { status: 400 }) }
  if (!constantTimeEqual(state, expected.state)) return new Response('GitHub sign-in could not be verified. Restart sign-in.', { status: 400 })
  const token = await tokenRequest(new URLSearchParams({ client_id: env.GITHUB_APP_CLIENT_ID, client_secret: env.GITHUB_APP_CLIENT_SECRET, code, redirect_uri: `${url.origin}/api/auth/callback`, code_verifier: expected.verifier }), 'authorization_code')
  const user = await githubApi<{ login: string }>('/user', token.access_token)
  if (user.login !== env.GITHUB_ALLOWED_LOGIN) return new Response('This GitHub account is not authorized for this personal tracker.', { status: 403 })
  const repository = await githubApi<{ full_name?: string; permissions?: { push?: boolean } }>(`/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}`, token.access_token)
  if (repository.full_name?.toLowerCase() !== `${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}`.toLowerCase() || repository.permissions?.push !== true) return new Response('The GitHub App must be installed for this account with read/write access to the private data repository.', { status: 403 })
  const expiresAt = Date.now() + Number(token.expires_in ?? 28_800) * 1000
  const refreshExpiresAt = Date.now() + Number(token.refresh_token_expires_in ?? 15_897_600) * 1000
  const session: AuthSession = { login: user.login, accessToken: token.access_token, refreshToken: token.refresh_token, accessExpiresAt: expiresAt, refreshExpiresAt }
  const sealed = await seal(session, env.SESSION_ENCRYPTION_KEY)
  const headers = new Headers({ Location: `${url.origin}/`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
  headers.append('Set-Cookie', `${COOKIE}=${sealed}; Path=/; Max-Age=${Math.floor((refreshExpiresAt - Date.now()) / 1000)}; HttpOnly; Secure; SameSite=Lax`)
  headers.append('Set-Cookie', `${STATE_COOKIE}=; Path=/api/auth/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax`)
  return new Response(null, { status: 302, headers })
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
  const response = await fetch(`https://api.github.com${path}`, { ...init, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': API_VERSION, 'Content-Type': 'application/json', ...init.headers } })
  if (!response.ok) {
    if (response.status === 401) throw new Error('Unauthorized: GitHub access expired; sign in again.')
    if (response.status === 409 || response.status === 422) throw new Error(`Revision conflict: GitHub rejected a stale write (${response.status}). Reload and reconcile.`)
    throw new Error(`GitHub repository request failed (${response.status}).`)
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
  const token = await response.json() as Record<string, unknown>
  if (!response.ok || typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string') throw new Error('Unauthorized: GitHub did not issue a renewable session. Sign in again.')
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
