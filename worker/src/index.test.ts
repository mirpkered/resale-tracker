import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { sealWorkerSession } from './index'
import { emptyData, emptyDocument, makeBatch } from '../../scripts/data-contract.mjs'

const key = btoa('0123456789abcdef0123456789abcdef')
const env = { ASSETS: { fetch: vi.fn() }, GITHUB_REPO_OWNER: 'mirpkered', GITHUB_REPO_NAME: 'resale-tracker-data', GITHUB_REPO_BRANCH: 'main', GITHUB_ALLOWED_LOGIN: 'mirpkered', GITHUB_APP_CLIENT_ID: 'public-client-id', GITHUB_APP_CLIENT_SECRET: 'test-secret', SESSION_ENCRYPTION_KEY: key } as unknown as Env
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const currentCookie = (header: string) => header.split(';')[0]
function repositoryMock(options: { failPatch?: boolean } = {}) {
  let head = 'commit-0', sequence = 0, failPatch = options.failPatch ?? false
  const document = emptyDocument('2026-11-04T00:00:00.000Z')
  const blobs = new Map([['blob-0', JSON.stringify(document)]])
  const trees = new Map([['tree-0', new Map([['current/resale-data.v2.json', 'blob-0']])]])
  const commits = new Map([['commit-0', 'tree-0']])
  const repoFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET', path = url.pathname
    if (path.endsWith('/git/ref/heads/main') && method === 'GET') return response({ object: { sha: head } })
    if (path.includes('/git/commits/') && method === 'GET') return response({ tree: { sha: commits.get(path.split('/').at(-1)!) } })
    if (path.includes('/git/trees/') && method === 'GET') {
      const tree = trees.get(path.split('/').at(-1)!)
      return response({ tree: [...(tree ?? new Map())].map(([path, sha]) => ({ path, sha })) })
    }
    if (path.includes('/git/blobs/') && method === 'GET') {
      const content = blobs.get(path.split('/').at(-1)!)
      return response({ content: btoa(content ?? ''), encoding: 'base64' })
    }
    if (path.endsWith('/git/blobs') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { content: string }
      const sha = `blob-${++sequence}`; blobs.set(sha, body.content); return response({ sha })
    }
    if (path.endsWith('/git/trees') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { base_tree: string; tree: Array<{ path: string; sha: string }> }
      const result = new Map(trees.get(body.base_tree) ?? [])
      for (const entry of body.tree) result.set(entry.path, entry.sha)
      const sha = `tree-${sequence}`; trees.set(sha, result); return response({ sha })
    }
    if (path.endsWith('/git/commits') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { tree: string; parents: string[] }
      const sha = `commit-${sequence}`; commits.set(sha, body.tree); (repoFetch as typeof repoFetch & { parent?: string }).parent = body.parents[0]; return response({ sha })
    }
    if (path.endsWith('/git/refs/heads/main') && method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as { sha: string }
      if (failPatch) return response({ message: 'temporary failure' }, 500)
      const parent = (repoFetch as typeof repoFetch & { parent?: string }).parent
      if (parent !== head) return response({ message: 'non-fast-forward' }, 422)
      head = body.sha; return response({ object: { sha: head } })
    }
    return response({ message: `Unexpected repository call ${method} ${path}` }, 404)
  })
  return { repoFetch, fail: (value: boolean) => { failPatch = value }, paths: () => [...(trees.get(commits.get(head)!) ?? new Map()).keys()], revision: () => JSON.parse(blobs.get((trees.get(commits.get(head)!) ?? new Map()).get('current/resale-data.v2.json')!)!).revision }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('private GitHub Worker authentication boundary', () => {
  it('rejects unauthenticated data reads and writes before contacting GitHub', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const read = await worker.fetch(new Request('https://sync.example.workers.dev/api/data'), env)
    const write = await worker.fetch(new Request('https://sync.example.workers.dev/api/data', { method: 'PUT', body: '{}' }), env)
    expect(read.status).toBe(401); expect(write.status).toBe(401); expect(fetchMock).not.toHaveBeenCalled()
  })

  it('starts OAuth with random state, PKCE, offline refresh access, and HttpOnly state cookie', async () => {
    const result = await worker.fetch(new Request('https://sync.example.workers.dev/api/auth/start'), env)
    const location = new URL(result.headers.get('location')!)
    expect(result.status).toBe(302)
    expect(location.origin).toBe('https://github.com')
    expect(location.searchParams.get('scope')).toBe('offline_access')
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(result.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Lax')
  })

  it('catches asynchronous OAuth start failures instead of leaking an uncaught Worker exception', async () => {
    vi.spyOn(crypto.subtle, 'importKey').mockRejectedValueOnce(new Error('test key import failure'))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = await worker.fetch(new Request('https://sync.example.workers.dev/api/auth/start'), env)
    expect(result.status).toBe(502)
    expect(await result.json()).toMatchObject({ error: 'sync_failed', message: 'test key import failure' })
    expect(errorLog).toHaveBeenCalledOnce()
  })

  it('accepts the documented login alias and redirects into the same protected OAuth flow', async () => {
    const result = await worker.fetch(new Request('https://sync.example.workers.dev/api/auth/login'), env)
    expect(result.status).toBe(302)
    expect(new URL(result.headers.get('location')!).origin).toBe('https://github.com')
    expect(result.headers.get('set-cookie')).toContain('rt_oauth_state=')
  })

  it('rejects a callback with a mismatched OAuth state before exchanging its code', async () => {
    const started = await worker.fetch(new Request('https://sync.example.workers.dev/api/auth/start'), env)
    const stateCookie = currentCookie(started.headers.get('set-cookie')!)
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const result = await worker.fetch(new Request('https://sync.example.workers.dev/api/auth/callback?code=not-real&state=attacker', { headers: { Cookie: stateCookie } }), env)
    expect(result.status).toBe(400); expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exchanges a valid OAuth callback and keeps GitHub tokens encrypted in HttpOnly cookies', async () => {
    const started = await worker.fetch(new Request('https://sync.example.workers.dev/api/auth/start'), env)
    const stateCookie = currentCookie(started.headers.get('set-cookie')!)
    const oauth = new URL(started.headers.get('location')!).searchParams
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ access_token: 'ghu-access-secret', refresh_token: 'ghr-refresh-secret', expires_in: 28800, refresh_token_expires_in: 15897600 }))
      .mockResolvedValueOnce(response({ login: 'mirpkered' }))
      .mockResolvedValueOnce(response({ full_name: 'mirpkered/resale-tracker-data', permissions: { push: true } }))
    vi.stubGlobal('fetch', fetchMock)
    const callback = await worker.fetch(new Request(`https://sync.example.workers.dev/api/auth/callback?code=oauth-code&state=${oauth.get('state')}`, { headers: { Cookie: stateCookie } }), env)
    const sessionCookie = callback.headers.get('set-cookie')!
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe('https://sync.example.workers.dev/')
    expect(sessionCookie).toContain('HttpOnly; Secure; SameSite=Lax')
    expect(sessionCookie).not.toContain('ghu-access-secret')
    expect(sessionCookie).not.toContain('ghr-refresh-secret')
    expect(sessionCookie).toContain('rt_github_session=')
  })

  it('catches asynchronous OAuth callback failures instead of leaking an uncaught Worker exception', async () => {
    const started = await worker.fetch(new Request('https://sync.example.workers.dev/api/auth/start'), env)
    const stateCookie = currentCookie(started.headers.get('set-cookie')!)
    const oauth = new URL(started.headers.get('location')!).searchParams
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('test token exchange failure')))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const callback = await worker.fetch(new Request(`https://sync.example.workers.dev/api/auth/callback?code=oauth-code&state=${oauth.get('state')}`, { headers: { Cookie: stateCookie } }), env)
    expect(callback.status).toBe(502)
    expect(await callback.json()).toMatchObject({ error: 'sync_failed', message: 'test token exchange failure' })
    expect(errorLog).toHaveBeenCalledOnce()
  })

  it('reports a safe GitHub OAuth rejection code without exposing the provider description', async () => {
    const started = await worker.fetch(new Request('https://sync.example.workers.dev/api/auth/start'), env)
    const stateCookie = currentCookie(started.headers.get('set-cookie')!)
    const oauth = new URL(started.headers.get('location')!).searchParams
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: 'incorrect_client_credentials', error_description: 'never echo provider details' }, 401)))
    const callback = await worker.fetch(new Request(`https://sync.example.workers.dev/api/auth/callback?code=oauth-code&state=${oauth.get('state')}`, { headers: { Cookie: stateCookie } }), env)
    const body = await callback.json() as { message: string }
    expect(callback.status).toBe(401)
    expect(body.message).toContain('(incorrect_client_credentials)')
    expect(body.message).not.toContain('never echo provider details')
  })

  it('identifies a missing refresh token without returning credential values', async () => {
    const started = await worker.fetch(new Request('https://sync.example.workers.dev/api/auth/start'), env)
    const stateCookie = currentCookie(started.headers.get('set-cookie')!)
    const oauth = new URL(started.headers.get('location')!).searchParams
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ access_token: 'ghu-test-token', expires_in: 28800 }, 200)))
    const callback = await worker.fetch(new Request(`https://sync.example.workers.dev/api/auth/callback?code=oauth-code&state=${oauth.get('state')}`, { headers: { Cookie: stateCookie } }), env)
    const body = await callback.json() as { message: string }
    expect(callback.status).toBe(401)
    expect(body.message).toContain('missing a refresh token')
    expect(body.message).not.toContain('ghu-test-token')
  })

  it('returns GitHub’s sanitized reason and API route for a repository permission denial', async () => {
    const started = await worker.fetch(new Request('https://sync.example.workers.dev/api/auth/start'), env)
    const stateCookie = currentCookie(started.headers.get('set-cookie')!)
    const oauth = new URL(started.headers.get('location')!).searchParams
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ access_token: 'ghu-private-token', refresh_token: 'ghr-private-token', expires_in: 28800, refresh_token_expires_in: 15897600 }))
      .mockResolvedValueOnce(response({ login: 'mirpkered' }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403, headers: { 'x-github-request-id': 'ABCD:1234:EF56' } }))
    vi.stubGlobal('fetch', fetchMock)
    const callback = await worker.fetch(new Request(`https://sync.example.workers.dev/api/auth/callback?code=oauth-code&state=${oauth.get('state')}`, { headers: { Cookie: stateCookie } }), env)
    const body = await callback.json() as { error: string; message: string }
    expect(callback.status).toBe(502)
    expect(body.error).toBe('sync_failed')
    expect(body.message).toContain('GET /repos/mirpkered/resale-tracker-data (403)')
    expect(body.message).toContain('Resource not accessible by integration')
    expect(body.message).toContain('GitHub request ABCD:1234:EF56')
    expect(body.message).not.toContain('ghu-private-token')
    expect(body.message).not.toContain('ghr-private-token')
  })

  it('rotates an expiring GitHub access token on the backend and returns a replacement cookie', async () => {
    const cookieValue = await sealWorkerSession({ login: 'mirpkered', accessToken: 'ghu-old', refreshToken: 'ghr-old', accessExpiresAt: Date.now() - 1000, refreshExpiresAt: Date.now() + 100_000 }, key)
    const fetchMock = vi.fn().mockResolvedValue(response({ access_token: 'ghu-new', refresh_token: 'ghr-new', expires_in: 28800, refresh_token_expires_in: 15897600 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await worker.fetch(new Request('https://sync.example.workers.dev/api/session', { headers: { Cookie: `rt_github_session=${cookieValue}` } }), env)
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ authenticated: true, login: 'mirpkered' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0][1].body)).toContain('grant_type=refresh_token')
    expect(result.headers.get('set-cookie')).toContain('rt_github_session=')
  })

  it('requires reauthorization after the refresh token expires', async () => {
    const cookieValue = await sealWorkerSession({ login: 'mirpkered', accessToken: 'ghu-old', refreshToken: 'ghr-old', accessExpiresAt: Date.now() - 1000, refreshExpiresAt: Date.now() - 1000 }, key)
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const result = await worker.fetch(new Request('https://sync.example.workers.dev/api/session', { headers: { Cookie: `rt_github_session=${cookieValue}` } }), env)
    expect(result.status).toBe(401); expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects cross-origin mutation requests before repository access', async () => {
    const cookieValue = await sealWorkerSession({ login: 'mirpkered', accessToken: 'ghu-valid', refreshToken: 'ghr-valid', accessExpiresAt: Date.now() + 3_600_000, refreshExpiresAt: Date.now() + 100_000 }, key)
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const result = await worker.fetch(new Request('https://sync.example.workers.dev/api/data', { method: 'PUT', headers: { Cookie: `rt_github_session=${cookieValue}`, Origin: 'https://attacker.example', 'Content-Type': 'application/json', 'X-Resale-Request': '1' }, body: '{}' }), env)
    expect(result.status).toBe(401); expect(fetchMock).not.toHaveBeenCalled()
  })

  it('commits one revision atomically with a recovery snapshot and acknowledges idempotent retries', async () => {
    const repo = repositoryMock(); vi.stubGlobal('fetch', repo.repoFetch)
    const cookie = await sealWorkerSession({ login: 'mirpkered', accessToken: 'ghu-valid', refreshToken: 'ghr-valid', accessExpiresAt: Date.now() + 3_600_000, refreshExpiresAt: Date.now() + 100_000 }, key)
    const batch = makeBatch(emptyData(), 0, 'stable-test-batch', '2026-11-04T01:00:00.000Z')
    const send = () => worker.fetch(new Request('https://sync.example.workers.dev/api/data', { method: 'PUT', headers: { Cookie: `rt_github_session=${cookie}`, Origin: 'https://sync.example.workers.dev', 'X-Resale-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ batch }) }), env)
    const first = await send(), firstBody = await first.json() as { document: { revision: number }; duplicate: boolean }
    expect(first.status).toBe(200); expect(firstBody.document.revision).toBe(1); expect(firstBody.duplicate).toBe(false)
    expect(repo.paths()).toContain('backups/r0-stable-test-batch.json')
    const callsBeforeRetry = repo.repoFetch.mock.calls.length
    const retry = await send(), retryBody = await retry.json() as { document: { revision: number }; duplicate: boolean }
    expect(retry.status).toBe(200); expect(retryBody.document.revision).toBe(1); expect(retryBody.duplicate).toBe(true)
    expect(repo.revision()).toBe(1)
    expect(repo.repoFetch.mock.calls.slice(callsBeforeRetry).filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0)
  })

  it('rejects a stale cross-device base revision without changing canonical data', async () => {
    const repo = repositoryMock(); vi.stubGlobal('fetch', repo.repoFetch)
    const cookie = await sealWorkerSession({ login: 'mirpkered', accessToken: 'ghu-valid', refreshToken: 'ghr-valid', accessExpiresAt: Date.now() + 3_600_000, refreshExpiresAt: Date.now() + 100_000 }, key)
    const send = (batchId: string) => worker.fetch(new Request('https://sync.example.workers.dev/api/data', { method: 'PUT', headers: { Cookie: `rt_github_session=${cookie}`, Origin: 'https://sync.example.workers.dev', 'X-Resale-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ batch: makeBatch(emptyData(), 0, batchId, '2026-11-04T01:00:00.000Z') }) }), env)
    expect((await send('first')).status).toBe(200)
    const stale = await send('second')
    expect(stale.status).toBe(409); expect(repo.revision()).toBe(1)
  })

  it('keeps canonical revision intact on failed writes and safely retries the same batch', async () => {
    const repo = repositoryMock({ failPatch: true }); vi.stubGlobal('fetch', repo.repoFetch)
    const cookie = await sealWorkerSession({ login: 'mirpkered', accessToken: 'ghu-valid', refreshToken: 'ghr-valid', accessExpiresAt: Date.now() + 3_600_000, refreshExpiresAt: Date.now() + 100_000 }, key)
    const batch = makeBatch(emptyData(), 0, 'retry-after-write-failure', '2026-11-04T01:00:00.000Z')
    const send = () => worker.fetch(new Request('https://sync.example.workers.dev/api/data', { method: 'PUT', headers: { Cookie: `rt_github_session=${cookie}`, Origin: 'https://sync.example.workers.dev', 'X-Resale-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ batch }) }), env)
    const failed = await send(); expect(failed.status).toBe(502); expect(repo.revision()).toBe(0)
    repo.fail(false)
    const retried = await send(); expect(retried.status).toBe(200); expect(repo.revision()).toBe(1)
  })
})
