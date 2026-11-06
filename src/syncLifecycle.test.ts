import { describe, expect, it, vi } from 'vitest'
import { attachCloudRefreshEvents, shouldRefreshCloud } from './syncLifecycle'

class FakeTarget {
  listeners = new Map<string, Set<() => void>>()
  addEventListener(type: string, listener: () => void) { const rows = this.listeners.get(type) ?? new Set(); rows.add(listener); this.listeners.set(type, rows) }
  removeEventListener(type: string, listener: () => void) { this.listeners.get(type)?.delete(listener) }
  fire(type: string) { for (const listener of this.listeners.get(type) ?? []) listener() }
}

describe('cloud refresh lifecycle', () => {
  it('does not poll while offline, hidden, or within the resume cooldown', () => {
    expect(shouldRefreshCloud({ online: false, visible: true, now: 30_000, lastCheck: 0 })).toBe(false)
    expect(shouldRefreshCloud({ online: true, visible: false, now: 30_000, lastCheck: 0 })).toBe(false)
    expect(shouldRefreshCloud({ online: true, visible: true, now: 5_000, lastCheck: 0 })).toBe(false)
    expect(shouldRefreshCloud({ online: true, visible: true, now: 13_000, lastCheck: 0 })).toBe(true)
  })

  it('checks again on PWA resume and connectivity restoration, and removes listeners on cleanup', () => {
    const win = new FakeTarget(), doc = Object.assign(new FakeTarget(), { visibilityState: 'hidden' }), refresh = vi.fn()
    const cleanup = attachCloudRefreshEvents(win, doc, refresh)
    win.fire('pageshow'); win.fire('online'); doc.fire('visibilitychange')
    expect(refresh).toHaveBeenCalledTimes(2)
    doc.visibilityState = 'visible'; doc.fire('visibilitychange')
    expect(refresh).toHaveBeenCalledTimes(3)
    cleanup(); win.fire('pageshow'); expect(refresh).toHaveBeenCalledTimes(3)
  })
})
