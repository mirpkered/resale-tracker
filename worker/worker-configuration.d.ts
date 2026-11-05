// Minimal Worker bindings needed for local type-checking. Secret values are configured outside the repository.
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  GITHUB_REPO_OWNER: string
  GITHUB_REPO_NAME: string
  GITHUB_REPO_BRANCH: string
  GITHUB_ALLOWED_LOGIN: string
  GITHUB_APP_CLIENT_ID: string
  GITHUB_APP_CLIENT_SECRET: string
  SESSION_ENCRYPTION_KEY: string
}

interface ExportedHandler<E> {
  fetch(request: Request, env: E): Promise<Response> | Response
}
