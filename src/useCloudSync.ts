import { useCallback, useEffect, useRef, useState } from 'react'
import { applyCloudMerge, applyThreeWayChoices, CloudSyncError, GitHubCloudStorageAdapter, hasTrackerRecords, previewCloudMerge, reconcileCloudSnapshots, requiresCloudMergeReview, threeWayMerge, type CloudSession, type CloudSyncStatus, type MergeChoice, type MergePreview } from './cloudSync'
import type { TrackerData } from './domain'
import { adoptRemoteDocument, clearRememberedSignOut, exportPendingBatch, isWorkspaceDirty, preserveLocalRecoveryBackup, receiveRemoteDocument, rememberSignOut, saveWorkspace, withLocalData, type LocalWorkspace, type RemoteDocument } from './storage'
import { attachCloudRefreshEvents, shouldRefreshCloud } from './syncLifecycle'

const enabled = import.meta.env.VITE_AUTO_SYNC_ENABLED === '1'
const serialize = (data: TrackerData) => JSON.stringify(data)
type MergeState = { preview: MergePreview; remote: RemoteDocument; source: 'initial' | 'conflict'; strategy?: 'three_way'; baseline?: TrackerData; localSnapshot: string; workspaceSnapshot: string; localData: TrackerData }

export function useCloudSync(workspace: LocalWorkspace, setWorkspace: (workspace: LocalWorkspace) => void, setData: (data: TrackerData) => void, online: boolean) {
  const adapter = useRef(new GitHubCloudStorageAdapter()).current
  const workspaceRef = useRef(workspace); workspaceRef.current = workspace
  const dataRef = useRef(workspace.data); dataRef.current = workspace.data
  const sessionRef = useRef<CloudSession | null>(null)
  const savingRef = useRef(false)
  const retryCountRef = useRef(0)
  const initializedRef = useRef(false)
  const connectionPromiseRef = useRef<Promise<void> | null>(null)
  const lastConnectionCheckRef = useRef(0)
  const [session, setSession] = useState<CloudSession | null>(null)
  const [configured, setConfigured] = useState(!enabled)
  const [status, setStatus] = useState<CloudSyncStatus>(enabled ? 'loading' : 'signed_out')
  const [merge, setMerge] = useState<MergeState | null>(null)
  const [recoveryRemote, setRecoveryRemote] = useState<RemoteDocument | null>(null)
  const [choices, setChoices] = useState<Record<string, MergeChoice>>({})
  const [error, setError] = useState('')
  const [revision, setRevision] = useState<number | null>(null)
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)

  const acceptRemote = useCallback((document: RemoteDocument) => {
    const current = workspaceRef.current
    const result = receiveRemoteDocument(current, JSON.stringify(document))
    if (result.conflict) {
      saveWorkspace(result.workspace); setWorkspace(result.workspace); setStatus('conflict')
      return false
    }
    workspaceRef.current = result.workspace; dataRef.current = result.workspace.data
    setWorkspace(result.workspace); setData(result.workspace.data); setRevision(result.workspace.baseRevision); setLastSavedAt(result.workspace.lastConfirmedAt ?? document.updatedAt)
    return true
  }, [setData, setWorkspace])

  const loadRemote = useCallback(async (source: 'initial' | 'conflict') => {
    const loaded = await adapter.load()
    const current = workspaceRef.current
    if (loaded.document.revision < current.baseRevision) { setStatus('conflict'); setError(`GitHub returned revision ${loaded.document.revision}, older than this device’s confirmed revision ${current.baseRevision}. Local data was left unchanged.`); return }
    setRevision(loaded.document.revision); setLastSavedAt(loaded.syncConfirmedAt)
    const dirty = isWorkspaceDirty(current), remoteChanged = current.baseRevision !== loaded.document.revision || current.baseline !== serialize(loaded.document.data)
    if (current.recoveryRequired || typeof current.baseline !== 'string') {
      setRecoveryRemote(loaded.document); setMerge(null); setStatus('needs_merge'); setError('This device has records but no verified sync baseline. Review the one-step recovery choice before replacing them.'); return
    }
    const firstEmptyConnection = current.baseRevision === 0 && loaded.document.revision === 0
    if (current.baseRevision === 0 && requiresCloudMergeReview(current.data, loaded.document.data, remoteChanged, firstEmptyConnection)) {
      setMerge({ preview: previewCloudMerge(current.data, loaded.document.data), remote: loaded.document, source, localSnapshot: serialize(current.data), workspaceSnapshot: serialize(current.data), localData: current.data }); setChoices({}); setStatus('needs_merge'); return
    }
    if (dirty && !remoteChanged) { setStatus('unsynced'); setError('Local changes are queued and will save automatically.'); return }
    if (!dirty) {
      if (remoteChanged && hasTrackerRecords(current.data)) preserveLocalRecoveryBackup(current, `Automatic sync recovery before adopting GitHub revision ${loaded.document.revision}.`)
      if (!acceptRemote(loaded.document)) { setError('The local snapshot could not be safely advanced to GitHub. Local data remains preserved.'); return }
      setRecoveryRemote(null); setMerge(null); setError(''); setStatus('saved'); return
    }
    const reconciliation = reconcileCloudSnapshots(current.baseline, current.data, current.baseRevision, loaded.document, current.recoveryRequired)
    if (reconciliation.kind === 'recovery') {
      setRecoveryRemote(loaded.document); setStatus('needs_merge'); setError('This device’s sync baseline is unreadable. Its records remain unchanged until you choose a recovery action.'); return
    }
    const result = reconciliation.preview!
    if (reconciliation.kind === 'conflict') {
      setMerge({ preview: result, remote: loaded.document, source: 'conflict', strategy: 'three_way', baseline: JSON.parse(current.baseline) as TrackerData, localSnapshot: serialize(current.data), workspaceSnapshot: serialize(current.data), localData: current.data }); setChoices({}); setStatus('conflict'); setError('Only overlapping edits need review. Other local and cloud changes have been merged safely.'); return
    }
    if (reconciliation.kind === 'adopt_cloud' || serialize(result.data) === serialize(loaded.document.data)) {
      if (!acceptRemote(loaded.document)) { setError('Local changes and the latest cloud revision both changed. Review the merge before saving.'); return }
      setError(''); setStatus('saved'); return
    }
    const rebased: LocalWorkspace = { ...current, data: result.data, baseRevision: loaded.document.revision, baseline: serialize(loaded.document.data), pendingBatch: undefined, remoteCandidate: undefined, recoveryRequired: undefined }
    saveWorkspace(rebased); workspaceRef.current = rebased; dataRef.current = result.data; setWorkspace(rebased); setData(result.data); setRecoveryRemote(null); setMerge(null); setError(''); setStatus('unsynced')
  }, [acceptRemote, adapter, setData, setWorkspace])

  const connect = useCallback(() => { window.location.assign('/api/auth/start') }, [])
  const signOut = useCallback(async () => {
    rememberSignOut()
    try { await adapter.signOut() } finally { sessionRef.current = null; setSession(null); setMerge(null); setStatus('signed_out'); setError('Signed out. This browser’s local records remain in place.') }
  }, [adapter])

  const checkConnection = useCallback(async () => {
    if (!enabled) return
    if (connectionPromiseRef.current) return connectionPromiseRef.current
    const running = (async () => {
    setStatus('loading'); setError('')
    try {
      const health = await adapter.health(); setConfigured(health.configured)
      if (!health.configured) { sessionRef.current = null; setSession(null); setStatus('signed_out'); setError('Private GitHub sign-in is not configured on this service.'); return }
      const current = await adapter.session()
      if (!current) { sessionRef.current = null; setSession(null); setStatus('signed_out'); return }
      clearRememberedSignOut()
      sessionRef.current = current; setSession(current)
      await loadRemote('initial')
    } catch (cause) {
      setStatus(!navigator.onLine ? 'offline' : cause instanceof CloudSyncError && cause.status === 401 ? 'reauthorize' : 'failed')
      setError(!navigator.onLine ? 'Offline. The last confirmed inventory remains on this device when available.' : cause instanceof Error ? cause.message : 'Could not load private GitHub data.')
    }
    })()
    connectionPromiseRef.current = running
    try { await running } finally { connectionPromiseRef.current = null; lastConnectionCheckRef.current = Date.now() }
  }, [adapter, loadRemote])

  useEffect(() => {
    if (!enabled || initializedRef.current) return
    initializedRef.current = true
    void checkConnection()
  }, [checkConnection])
  useEffect(() => {
    if (enabled && online && status === 'offline') void checkConnection()
  }, [checkConnection, online, status])
  useEffect(() => {
    if (!enabled) return
    const refreshIfDue = () => {
      if (shouldRefreshCloud({ online: navigator.onLine, visible: document.visibilityState === 'visible', now: Date.now(), lastCheck: lastConnectionCheckRef.current })) void checkConnection()
    }
    return attachCloudRefreshEvents(window, document, refreshIfDue)
  }, [checkConnection])

  const saveNow = useCallback(async () => {
    if (!enabled || !sessionRef.current || savingRef.current || !online || merge) return
    const starting = workspaceRef.current
    if (!isWorkspaceDirty(starting)) { setStatus('saved'); return }
    savingRef.current = true; setStatus('saving'); setError('')
    try {
      const prepared = exportPendingBatch(starting)
      workspaceRef.current = prepared.workspace; setWorkspace(prepared.workspace)
      const saved = await adapter.save(prepared.batch)
      const latest = workspaceRef.current
      const result = receiveRemoteDocument(latest, JSON.stringify(saved.document))
      if (result.conflict) {
        saveWorkspace(result.workspace); setWorkspace(result.workspace); setRevision(saved.document.revision); setStatus('conflict'); setError('A newer local edit arrived during save. Your local changes are preserved; review the latest cloud revision.')
      } else {
        workspaceRef.current = result.workspace; dataRef.current = result.workspace.data
        setWorkspace(result.workspace); setData(result.workspace.data); setRevision(saved.document.revision); setLastSavedAt(saved.syncConfirmedAt); setStatus('saved')
      }
    } catch (cause) {
      const current = workspaceRef.current
      if (cause instanceof CloudSyncError && cause.status === 401) { sessionRef.current = null; setSession(null); setStatus('reauthorize'); setError('GitHub authorization expired. Sign in again; your local edits are preserved.') }
      else if (cause instanceof CloudSyncError && cause.status === 409) {
        try {
          const latest = await adapter.load()
          setRevision(latest.document.revision)
          if (latest.document.revision < current.baseRevision) { setStatus('conflict'); setError('GitHub returned a revision older than this device’s confirmed snapshot. Local edits remain queued.'); return }
          if (typeof current.baseline !== 'string' || current.recoveryRequired) { setRecoveryRemote(latest.document); setStatus('needs_merge'); setError('The browser baseline is unavailable. Your local changes remain preserved for recovery.'); return }
          const baseline = JSON.parse(current.baseline) as TrackerData, result = threeWayMerge(baseline, current.data, latest.document.data)
          if (!result.conflicts.length) {
            const rebased: LocalWorkspace = { ...current, data: result.data, baseRevision: latest.document.revision, baseline: serialize(latest.document.data), pendingBatch: undefined, remoteCandidate: undefined }
            saveWorkspace(rebased); workspaceRef.current = rebased; dataRef.current = result.data; setWorkspace(rebased); setData(result.data); setStatus('unsynced'); setError('Cloud changes were merged. Your local edits are queued for save.')
          } else {
            setMerge({ preview: result, remote: latest.document, source: 'conflict', strategy: 'three_way', baseline, localSnapshot: serialize(current.data), workspaceSnapshot: serialize(current.data), localData: current.data }); setChoices({}); setStatus('conflict'); setError('Another device changed the same fields. Nonoverlapping changes were merged; review only these overlapping edits.')
          }
        } catch { setStatus('conflict'); setError(cause.message) }
      } else {
        setStatus(navigator.onLine ? 'failed' : 'offline'); setError(cause instanceof Error ? cause.message : 'Cloud save failed. Local edits remain queued.')
        if (navigator.onLine) { retryCountRef.current = Math.min(retryCountRef.current + 1, 6); const delay = Math.min(60_000, 2_000 * 2 ** (retryCountRef.current - 1)); window.setTimeout(() => { void saveNow() }, delay) }
      }
    } finally { savingRef.current = false }
  }, [adapter, merge, online, setData, setWorkspace])

  useEffect(() => {
    if (!enabled || !session || !online || merge || !isWorkspaceDirty(workspace)) {
      if (enabled && !online && session && isWorkspaceDirty(workspace)) setStatus('offline')
      return
    }
    setStatus('unsynced')
    const timer = window.setTimeout(() => { void saveNow() }, 650)
    return () => window.clearTimeout(timer)
  }, [merge, online, saveNow, session, workspace])

  const approveMerge = useCallback(async () => {
    if (!merge || !sessionRef.current) return
    const current = workspaceRef.current
    const fresh = await adapter.load()
    if (fresh.document.revision !== merge.remote.revision) {
      const preview = merge.strategy === 'three_way' && merge.baseline ? threeWayMerge(merge.baseline, merge.localData, fresh.document.data) : previewCloudMerge(merge.localData, fresh.document.data)
      const next = { preview, remote: fresh.document, source: 'conflict' as const, strategy: merge.strategy, baseline: merge.baseline, localSnapshot: merge.localSnapshot, workspaceSnapshot: merge.workspaceSnapshot, localData: merge.localData }
      setMerge(next); setRevision(fresh.document.revision); setChoices({}); setStatus('conflict'); setError('Cloud data changed while you reviewed the merge. Review the refreshed preview before approving.')
      return
    }
    if (serialize(current.data) !== merge.workspaceSnapshot) {
      if (merge.localSnapshot !== merge.workspaceSnapshot) { setMerge(null); setError('The browser workspace changed while reviewing this backup. Import the backup again to create a fresh review.'); return }
      const baseline = merge.strategy === 'three_way' ? merge.baseline : undefined
      const preview = baseline ? threeWayMerge(baseline, current.data, fresh.document.data) : previewCloudMerge(current.data, fresh.document.data)
      setMerge({ preview, remote: fresh.document, source: 'conflict', strategy: merge.strategy, baseline, localSnapshot: serialize(current.data), workspaceSnapshot: serialize(current.data), localData: current.data }); setChoices({}); setError('Local records changed while you reviewed the merge. Review the refreshed preview before approving.')
      return
    }
    try {
      const combined = merge.strategy === 'three_way'
        ? applyThreeWayChoices(merge.preview.data, merge.preview.conflicts, choices)
        : applyCloudMerge(merge.localData, fresh.document.data, merge.preview, choices)
      combined.auditEvents = [...(combined.auditEvents ?? []), { id: crypto.randomUUID(), at: new Date().toISOString(), action: 'cloud_merge', summary: 'Approved local and GitHub records in a cloud reconciliation.' }].slice(-500)
      const rebased = { ...current, data: combined, baseRevision: fresh.document.revision, baseline: serialize(fresh.document.data), pendingBatch: undefined, remoteCandidate: undefined }
      const queued = withLocalData(rebased, combined)
      workspaceRef.current = queued; dataRef.current = combined; setWorkspace(queued); setData(combined); setMerge(null); setChoices({}); setStatus('unsynced'); setError('')
      window.setTimeout(() => { void saveNow() }, 0)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not merge local records.') }
  }, [adapter, choices, merge, saveNow, setData, setWorkspace])

  const recoverByLoadingCloud = useCallback(async () => {
    if (!recoveryRemote || !sessionRef.current) return
    try {
      const fresh = await adapter.load()
      preserveLocalRecoveryBackup(workspaceRef.current, `Explicit recovery before loading GitHub revision ${fresh.document.revision}.`)
      const next = adoptRemoteDocument(JSON.stringify(fresh.document))
      workspaceRef.current = next; dataRef.current = next.data; setWorkspace(next); setData(next.data); setRevision(next.baseRevision); setLastSavedAt(fresh.syncConfirmedAt); setRecoveryRemote(null); setMerge(null); setError('A recoverable copy of the prior device data was saved before loading GitHub.'); setStatus('saved')
    } catch (cause) { setStatus('failed'); setError(cause instanceof Error ? cause.message : 'Could not safely recover the cloud snapshot.') }
  }, [adapter, recoveryRemote, setData, setWorkspace])

  const reviewLatest = useCallback(async () => {
    try { await loadRemote('conflict') } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load the latest revision.') }
  }, [loadRemote])

  const reviewLocalBackup = useCallback(async (localData: TrackerData) => {
    if (!sessionRef.current) throw new Error('Sign in before importing a device backup.')
    const current = workspaceRef.current, loaded = await adapter.load()
    setRevision(loaded.document.revision); setLastSavedAt(loaded.syncConfirmedAt)
    setMerge({ preview: previewCloudMerge(localData, loaded.document.data), remote: loaded.document, source: 'initial', localSnapshot: serialize(localData), workspaceSnapshot: serialize(current.data), localData })
    setChoices({}); setStatus('needs_merge'); setError('Review the imported device backup before syncing it.')
  }, [adapter])

  return { enabled, configured, session, status, merge, recoveryRemote, recoverByLoadingCloud, choices, setChoice: (key: string, value: MergeChoice) => setChoices((current) => ({ ...current, [key]: value })), approveMerge, connect, signOut, reviewLatest, refresh: () => loadRemote('initial'), retry: checkConnection, reviewLocalBackup, error, revision, lastSavedAt }
}
