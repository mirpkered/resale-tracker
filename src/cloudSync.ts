import type { TrackerData } from './domain'
import type { RemoteDocument, SyncBatch } from './storage'

export type CloudSession = { authenticated: true; login: string; expiresAt: number }
export type CloudSyncStatus = 'signed_out' | 'workspace_required' | 'loading' | 'needs_merge' | 'saved' | 'saving' | 'offline' | 'unsynced' | 'failed' | 'conflict' | 'reauthorize'
export type MergeChoice = 'local' | 'cloud'
export type MergeConflict = { collection: keyof TrackerData; id: string; cloudId: string; title: string; reason: 'changed_record' | 'possible_duplicate' }
export type MergePreview = { data: TrackerData; added: Array<{ collection: keyof TrackerData; id: string; title: string }>; existing: number; conflicts: MergeConflict[]; duplicateImports: number }

export class CloudSyncError extends Error {
  constructor(message: string, readonly status: number, readonly kind?: string) { super(message); this.name = 'CloudSyncError' }
}

export class GitHubCloudStorageAdapter {
  constructor(private readonly base = '/api') {}

  async health(): Promise<{ configured: boolean }> { return this.read(await fetch(`${this.base}/health`, { credentials: 'same-origin', cache: 'no-store' })) }

  async session(): Promise<CloudSession | null> {
    const response = await fetch(`${this.base}/session`, { credentials: 'same-origin', cache: 'no-store' })
    if (response.status === 401) return null
    return this.read<CloudSession>(response)
  }

  async load(): Promise<{ document: RemoteDocument; commitSha: string; syncConfirmedAt: string }> {
    return this.read(await fetch(`${this.base}/data`, { credentials: 'same-origin', cache: 'no-store' }))
  }

  async save(batch: SyncBatch): Promise<{ document: RemoteDocument; duplicate: boolean; commitSha: string; syncConfirmedAt: string }> {
    return this.read(await fetch(`${this.base}/data`, { method: 'PUT', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Resale-Request': '1' }, body: JSON.stringify({ batch }) }))
  }

  async signOut(): Promise<void> { await this.read(await fetch(`${this.base}/auth/sign-out`, { method: 'POST', credentials: 'same-origin', headers: { 'X-Resale-Request': '1' } })) }

  private async read<T>(response: Response): Promise<T> {
    const body = await response.json() as T & { error?: string; message?: string }
    if (!response.ok) throw new CloudSyncError(body.message ?? `Cloud sync failed (${response.status}).`, response.status, body.error)
    return body
  }
}

const collections: Array<keyof TrackerData> = ['purchaseGroups', 'lots', 'items', 'units', 'sales', 'ledgerTransactions', 'expenses', 'credit', 'platforms', 'auditEvents']
type RecordWithId = { id: string; title?: string; name?: string; description?: string; date?: string; externalSource?: string; externalId?: string; itemId?: string }
const records = (data: TrackerData, collection: keyof TrackerData): RecordWithId[] => (data[collection] ?? []) as RecordWithId[]
const serialize = (value: unknown) => JSON.stringify(value)
const stableKey = (row: RecordWithId) => row.externalSource && row.externalId ? `${row.externalSource}:${row.externalId}` : row.externalId ? `external:${row.externalId}` : null
const titleOf = (row: RecordWithId) => row.title ?? row.name ?? row.description ?? row.date ?? row.id
const hasRecords = (data: TrackerData) => collections.some((collection) => records(data, collection).length > 0)

export function requiresCloudMergeReview(local: TrackerData, cloud: TrackerData, remoteChanged = true, firstEmptyConnection = false): boolean {
  return hasRecords(local) && serialize(local) !== serialize(cloud) && (remoteChanged || firstEmptyConnection)
}

export function previewCloudMerge(local: TrackerData, cloud: TrackerData): MergePreview {
  const added: MergePreview['added'] = [], conflicts: MergeConflict[] = []
  let existing = 0, duplicateImports = 0
  const data = { ...cloud } as TrackerData
  const remaps = new Map<keyof TrackerData, Map<string, string>>()
  for (const collection of collections) {
    const cloudRows = records(cloud, collection), localRows = records(local, collection)
    const merged = [...cloudRows]
    for (const row of localRows) {
      const byId = cloudRows.find((candidate) => candidate.id === row.id)
      if (byId) {
        if (serialize(byId) === serialize(row)) existing++
        else conflicts.push({ collection, id: row.id, cloudId: byId.id, title: titleOf(row), reason: 'changed_record' })
        continue
      }
      const key = stableKey(row)
      const byExternal = key ? cloudRows.find((candidate) => stableKey(candidate) === key) : undefined
      if (byExternal) {
        duplicateImports++
        conflicts.push({ collection, id: row.id, cloudId: byExternal.id, title: titleOf(row), reason: 'possible_duplicate' })
        const mapping = remaps.get(collection) ?? new Map<string, string>()
        mapping.set(row.id, byExternal.id); remaps.set(collection, mapping)
        continue
      }
      const normalized = applyReferenceRemaps(collection, row, remaps)
      merged.push(normalized); added.push({ collection, id: row.id, title: titleOf(row) })
    }
    if (local[collection] !== undefined || cloud[collection] !== undefined) (data as unknown as Record<string, unknown>)[collection] = merged
  }
  return { data, added, existing, conflicts, duplicateImports }
}

export function applyCloudMerge(local: TrackerData, cloud: TrackerData, preview: MergePreview, choices: Record<string, MergeChoice>): TrackerData {
  if (preview.conflicts.some((conflict) => !choices[`${conflict.collection}:${conflict.id}`])) throw new Error('Resolve every cloud merge conflict before approving the merge.')
  const result = { ...preview.data } as TrackerData
  const selectedCloudRemaps = new Map<keyof TrackerData, Map<string, string>>()
  for (const conflict of preview.conflicts) if (choices[`${conflict.collection}:${conflict.id}`] === 'cloud' && conflict.cloudId !== conflict.id) {
    const mapping = selectedCloudRemaps.get(conflict.collection) ?? new Map<string, string>()
    mapping.set(conflict.id, conflict.cloudId); selectedCloudRemaps.set(conflict.collection, mapping)
  }
  for (const conflict of preview.conflicts) {
    const key = `${conflict.collection}:${conflict.id}`
    if (choices[key] !== 'local') continue
    const rows = records(local, conflict.collection)
    const cloudRow = records(cloud, conflict.collection).find((row) => row.id === conflict.cloudId)
    const candidateRaw = rows.find((row) => row.id === conflict.id) ?? (cloudRow ? rows.find((row) => stableKey(row) === stableKey(cloudRow)) : undefined)
    const candidate = candidateRaw ? applyReferenceRemaps(conflict.collection, candidateRaw, selectedCloudRemaps) : undefined
    if (!candidate) throw new Error(`Local merge record ${conflict.id} is no longer available.`)
    const existing = records(result, conflict.collection)
    const index = existing.findIndex((row) => row.id === conflict.cloudId || row.id === conflict.id || Boolean(stableKey(candidate) && stableKey(row) === stableKey(candidate)))
    if (index >= 0) existing[index] = candidate
    else if (cloudRow) existing.push(candidate)
    else existing.push(candidate)
    ;(result as unknown as Record<string, unknown>)[conflict.collection] = existing
    if (conflict.cloudId !== candidate.id) remapDataReferences(result, conflict.collection, conflict.cloudId, candidate.id)
  }
  return result
}

function applyReferenceRemaps(collection: keyof TrackerData, row: RecordWithId, remaps: Map<keyof TrackerData, Map<string, string>>): RecordWithId {
  const next = JSON.parse(JSON.stringify(row)) as Record<string, unknown>
  const lookup = (kind: keyof TrackerData, id: unknown) => typeof id === 'string' ? remaps.get(kind)?.get(id) ?? id : id
  if (collection === 'lots') next.reportingGroupId = lookup('purchaseGroups', next.reportingGroupId)
  if (collection === 'items') next.lotId = lookup('lots', next.lotId)
  if (collection === 'units') next.itemId = lookup('items', next.itemId)
  if (collection === 'sales') {
    if (Array.isArray(next.itemIds)) next.itemIds = next.itemIds.map((id) => lookup('items', id))
    if (Array.isArray(next.lines)) next.lines = next.lines.map((line) => { const value = line as Record<string, unknown>; return { ...value, itemId: lookup('items', value.itemId), unitIds: Array.isArray(value.unitIds) ? value.unitIds.map((id) => lookup('units', id)) : value.unitIds } })
  }
  if (collection === 'ledgerTransactions' && Array.isArray(next.itemUnitIds)) next.itemUnitIds = next.itemUnitIds.map((unitIds) => Array.isArray(unitIds) ? unitIds.map((id) => lookup('units', id)) : unitIds)
  return next as RecordWithId
}

function remapDataReferences(data: TrackerData, collection: keyof TrackerData, from: string, to: string) {
  const replace = (id: unknown) => id === from ? to : id
  if (collection === 'purchaseGroups') data.lots = data.lots.map((lot) => ({ ...lot, reportingGroupId: replace(lot.reportingGroupId) as string | undefined }))
  if (collection === 'lots') data.items = data.items.map((item) => ({ ...item, lotId: replace(item.lotId) as string | null }))
  if (collection === 'items') {
    data.units = data.units?.map((unit) => ({ ...unit, itemId: replace(unit.itemId) as string }))
    data.sales = data.sales.map((sale) => ({ ...sale, itemIds: sale.itemIds.map((id) => replace(id) as string), lines: sale.lines?.map((line) => ({ ...line, itemId: replace(line.itemId) as string })) }))
  }
  if (collection === 'units') {
    data.sales = data.sales.map((sale) => ({ ...sale, lines: sale.lines?.map((line) => ({ ...line, unitIds: line.unitIds?.map((id) => replace(id) as string) })) }))
    data.ledgerTransactions = data.ledgerTransactions?.map((entry) => ({ ...entry, itemUnitIds: entry.itemUnitIds?.map((ids) => ids.map((id) => replace(id) as string)) }))
  }
}
