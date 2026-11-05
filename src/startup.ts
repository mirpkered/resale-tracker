export type StartupView = 'pages' | 'loading' | 'signin' | 'offline' | 'error' | 'app'

export interface StartupState {
  cloudEnabled: boolean
  online: boolean
  authenticated: boolean
  status: string
  hasConfirmedSnapshot: boolean
  explicitlySignedOut: boolean
}

export function resolveStartupView(state: StartupState): StartupView {
  if (!state.cloudEnabled) return 'pages'
  if (!state.online) return state.hasConfirmedSnapshot && !state.explicitlySignedOut ? 'app' : 'offline'
  if (state.status === 'loading') return 'loading'
  if (!state.authenticated) return 'signin'
  if (state.status === 'failed' && !state.hasConfirmedSnapshot) return 'error'
  return 'app'
}
