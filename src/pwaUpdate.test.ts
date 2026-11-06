import { describe, expect, it } from 'vitest'
import { canActivateAppUpdate } from './pwaUpdate'

describe('app-shell updates', () => {
  it('waits for local edits and saves before activating a new worker', () => {
    expect(canActivateAppUpdate(true, 'saved')).toBe(false)
    expect(canActivateAppUpdate(false, 'saved', true)).toBe(false)
    expect(canActivateAppUpdate(false, 'saving')).toBe(false)
    expect(canActivateAppUpdate(false, 'unsynced')).toBe(false)
    expect(canActivateAppUpdate(false, 'conflict')).toBe(false)
  })

  it('allows a safe update after data is persisted or while signed out with no local edits', () => {
    expect(canActivateAppUpdate(false, 'saved')).toBe(true)
    expect(canActivateAppUpdate(false, 'signed_out')).toBe(true)
  })
})
