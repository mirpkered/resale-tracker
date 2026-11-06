export interface LifecycleDocumentLike { visibilityState: string; addEventListener(type: string, listener: () => void): void; removeEventListener(type: string, listener: () => void): void }
export interface LifecycleWindowLike { addEventListener(type: string, listener: () => void): void; removeEventListener(type: string, listener: () => void): void }

export function shouldRefreshCloud(input: { online: boolean; visible: boolean; now: number; lastCheck: number; cooldownMs?: number }): boolean {
  return input.online && input.visible && input.now - input.lastCheck >= (input.cooldownMs ?? 12_000)
}

export function attachCloudRefreshEvents(win: LifecycleWindowLike, doc: LifecycleDocumentLike, refresh: () => void): () => void {
  const onResume = () => refresh()
  const onVisibility = () => { if (doc.visibilityState === 'visible') refresh() }
  win.addEventListener('pageshow', onResume)
  win.addEventListener('online', onResume)
  doc.addEventListener('visibilitychange', onVisibility)
  return () => {
    win.removeEventListener('pageshow', onResume)
    win.removeEventListener('online', onResume)
    doc.removeEventListener('visibilitychange', onVisibility)
  }
}
