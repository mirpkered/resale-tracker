import { useCallback, useEffect, useRef, useState } from 'react'
import { applyCloudMerge, CloudSyncError, GitHubCloudStorageAdapter, previewCloudMerge, requiresCloudMergeReview, type CloudSession, type CloudSyncStatus, type MergeChoice, type MergePreview } from './cloudSync'
import type { TrackerData } from './domain'
import { exportPendingBatch, isWorkspaceDirty, receiveRemoteDocument, saveWorkspace, withLocalData, type LocalWorkspace, type RemoteDocument } from './storage'

const enabled = import.meta.env.VITE_AUTO_SYNC_ENABLED === '1'
const serialize = (data: TrackerData) => JSON.stringify(data)
type MergeState = { preview: MergePreview; remote: RemoteDocument; source: 'initial' | 'conflict'; localSnapshot: string; workspaceSnapshot: string; localData: TrackerData }

export function useCloudSync(workspace: LocalWorkspace, setWorkspace: (workspace: LocalWorkspace) => void, setData: (data: TrackerData) => void, online: boolean) {
  const adapter = useRef(new GitHubCloudStorageAdapter()).current
  const workspaceRef = useRef(workspace); workspaceRef.current = workspace
  const dataRef = useRef(workspace.data); dataRef.current = workspace.data
  const sessionRef = useRef<CloudSession | null>(null)
  const savingRef = useRef(false)
  const retryCountRef = useRef(0)
  const initializedRef = useRef(false)
  const [session, setSession] = useState<CloudSession | null>(null)
  const [configured, setConfigured] = useState(!enabled)
  const [status, setStatus] = useState<CloudSyncStatus>(enabled ? 'loading' : 'signed_out')
  const [merge, setMerge] = useState<MergeState | null>(null)
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
    setRevision(loaded.document.revision); setLastSavedAt(loaded.syncConfirmedAt)
    if (current.mode !== 'personal') { setStatus('signed_out'); setError('Sign in is connected. Create or select a personal workspace to sync; demo data stays isolated.'); return }
    const dirty = isWorkspaceDirty(current), remoteChanged = current.baseRevision !== loaded.document.revision || current.baseline !== serialize(loaded.document.data)
    const firstEmptyConnection = current.baseRevision === 0 && loaded.document.revision === 0
    if (requiresCloudMergeReview(current.data, loaded.document.data, remoteChanged, firstEmptyConnection)) {
      setMerge({ preview: previewCloudMerge(current.data, loaded.document.data), remote: loaded.document, source, localSnapshot: serialize(current.data), workspaceSnapshot: serialize(current.data), localData: current.data }); setChoices({}); setStatus('needs_merge'); return
    }
    if (dirty && !remoteChanged) { setStatus('unsynced'); setError('Local changes are queued and will save automatically.'); return }
    if (!acceptRemote(loaded.document)) { setError('Local changes and the latest cloud revision both changed. Review a merge before saving.'); return }
    setError(''); setStatus('saved')
  }, [acceptRemote, adapter])

  const connect = useCallback(() => { window.location.assign('/api/auth/start') }, [])
  const signOut = useCallback(async () => {
    try { await adapter.signOut() } finally { sessionRef.current = null; setSession(null); setMerge(null); setStatus('signed_out'); setError('Signed out. This browser’s local records remain in place.') }
  }, [adapter])

  useEffect(() => {
    if (!enabled || initializedRef.current) return
    initializedRef.current = true
    void (async () => {
      try {
        const health = await adapter.health(); setConfigured(health.configured)
        if (!health.configured) { setStatus('signed_out'); setError('The secure backend is deployed but awaits GitHub App setup. No inventory has been sent.'); return }
        const current = await adapter.session()
        if (!current) { setStatus('signed_out'); return }
        sessionRef.current = current; setSession(current)
        await loadRemote('initial')
      } catch (cause) {
        setStatus(cause instanceof CloudSyncError && cause.status === 401 ? 'reauthorize' : 'failed')
        setError(cause instanceof Error ? cause.message : 'Could not load private GitHub data.')
      }
    })()
  }, [adapter, loadRemote])

  const saveNow = useCallback(async () => {
    if (!enabled || !sessionRef.current || savingRef.current || !online || workspaceRef.current.mode !== 'personal' || merge) return
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
      if (cause instanceof CloudSyncError && cause.status === 401) { setStatus('reauthorize'); setError('GitHub authorization expired. Sign in again; your local edits are preserved.') }
      else if (cause instanceof CloudSyncError && cause.status === 409) {
        try {
          const latest = await adapter.load()
          setRevision(latest.document.revision); setMerge({ preview: previewCloudMerge(current.data, latest.document.data), remote: latest.document, source: 'conflict', localSnapshot: serialize(current.data), workspaceSnapshot: serialize(current.data), localData: current.data }); setChoices({}); setStatus('conflict'); setError('Another device saved first. Your edits are safe locally; review the cloud changes to continue.')
        } catch { setStatus('conflict'); setError(cause.message) }
      } else {
        setStatus(navigator.onLine ? 'failed' : 'offline'); setError(cause instanceof Error ? cause.message : 'Cloud save failed. Local edits remain queued.')
        if (navigator.onLine) { retryCountRef.current = Math.min(retryCountRef.current + 1, 6); const delay = Math.min(60_000, 2_000 * 2 ** (retryCountRef.current - 1)); window.setTimeout(() => { void saveNow() }, delay) }
      }
    } finally { savingRef.current = false }
  }, [adapter, merge, online, setData, setWorkspace])

  useEffect(() => {
    if (!enabled || !session || !online || workspace.mode !== 'personal' || merge || !isWorkspaceDirty(workspace)) {
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
    if (current.mode !== 'personal') return
    const fresh = await adapter.load()
    if (fresh.document.revision !== merge.remote.revision) {
      const next = { preview: previewCloudMerge(merge.localData, fresh.document.data), remote: fresh.document, source: 'conflict' as const, localSnapshot: merge.localSnapshot, workspaceSnapshot: merge.workspaceSnapshot, localData: merge.localData }
      setMerge(next); setRevision(fresh.document.revision); setChoices({}); setStatus('conflict'); setError('Cloud data changed while you reviewed the merge. Review the refreshed preview before approving.')
      return
    }
    if (serialize(current.data) !== merge.workspaceSnapshot) {
      if (merge.localSnapshot !== merge.workspaceSnapshot) { setMerge(null); setError('The browser workspace changed while reviewing this backup. Import the backup again to create a fresh review.'); return }
      setMerge({ preview: previewCloudMerge(current.data, fresh.document.data), remote: fresh.document, source: 'conflict', localSnapshot: serialize(current.data), workspaceSnapshot: serialize(current.data), localData: current.data }); setChoices({}); setError('Local records changed while you reviewed the merge. Review the refreshed preview before approving.')
      return
    }
    try {
      const combined = applyCloudMerge(merge.localData, fresh.document.data, merge.preview, choices)
      combined.auditEvents = [...(combined.auditEvents ?? []), { id: crypto.randomUUID(), at: new Date().toISOString(), action: 'cloud_merge', summary: 'Approved local and GitHub records in a cloud reconciliation.' }].slice(-500)
      const rebased = { ...current, data: combined, baseRevision: fresh.document.revision, baseline: serialize(fresh.document.data), pendingBatch: undefined, remoteCandidate: undefined }
      const queued = withLocalData(rebased, combined)
      workspaceRef.current = queued; dataRef.current = combined; setWorkspace(queued); setData(combined); setMerge(null); setChoices({}); setStatus('unsynced'); setError('')
      window.setTimeout(() => { void saveNow() }, 0)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not merge local records.') }
  }, [adapter, choices, merge, saveNow, setData, setWorkspace])

  const reviewLatest = useCallback(async () => {
    try { await loadRemote('conflict') } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load the latest revision.') }
  }, [loadRemote])

  const reviewLocalBackup = useCallback(async (localData: TrackerData) => {
    if (!sessionRef.current || workspaceRef.current.mode !== 'personal') throw new Error('Sign in and create a personal workspace before importing a device backup.')
    const current = workspaceRef.current, loaded = await adapter.load()
    setRevision(loaded.document.revision); setLastSavedAt(loaded.syncConfirmedAt)
    setMerge({ preview: previewCloudMerge(localData, loaded.document.data), remote: loaded.document, source: 'initial', localSnapshot: serialize(localData), workspaceSnapshot: serialize(current.data), localData })
    setChoices({}); setStatus('needs_merge'); setError('Review the imported device backup before syncing it.')
  }, [adapter])

  return { enabled, configured, session, status, merge, choices, setChoice: (key: string, value: MergeChoice) => setChoices((current) => ({ ...current, [key]: value })), approveMerge, connect, signOut, reviewLatest, refresh: () => loadRemote('initial'), reviewLocalBackup, error, revision, lastSavedAt }
}
