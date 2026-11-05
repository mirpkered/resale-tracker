import { describe, expect, it } from 'vitest'
import { resolveStartupView } from './startup'

const base = { cloudEnabled: true, online: true, authenticated: false, status: 'signed_out', hasConfirmedSnapshot: false, explicitlySignedOut: false }

describe('private inventory startup gate', () => {
  it('shows no inventory while signed out, and only then offers sign-in', () => {
    expect(resolveStartupView(base)).toBe('signin')
    expect(resolveStartupView({ ...base, status: 'loading' })).toBe('loading')
  })

  it('opens only after the authenticated cloud read succeeds, including empty repositories', () => {
    expect(resolveStartupView({ ...base, authenticated: true, status: 'saved' })).toBe('app')
    expect(resolveStartupView({ ...base, authenticated: true, status: 'saved', hasConfirmedSnapshot: true })).toBe('app')
  })

  it('shows the last confirmed snapshot offline, but honors an explicit sign-out', () => {
    expect(resolveStartupView({ ...base, online: false, status: 'offline', hasConfirmedSnapshot: true })).toBe('app')
    expect(resolveStartupView({ ...base, online: false, status: 'offline', hasConfirmedSnapshot: true, explicitlySignedOut: true })).toBe('offline')
    expect(resolveStartupView({ ...base, online: false, status: 'offline' })).toBe('offline')
  })

  it('provides a retry screen after a failed authenticated cloud read with no local snapshot', () => {
    expect(resolveStartupView({ ...base, authenticated: true, status: 'failed' })).toBe('error')
    expect(resolveStartupView({ ...base, authenticated: true, status: 'failed', hasConfirmedSnapshot: true })).toBe('app')
  })

  it('keeps the Pages recovery build out of the private inventory experience', () => {
    expect(resolveStartupView({ ...base, cloudEnabled: false })).toBe('pages')
  })
})
