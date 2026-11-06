import type { TrackerData } from './domain'
import type { RemoteDocument, SyncBatch } from './storage'

export type CloudSession = { authenticated: true; login: string; expiresAt: number }
export type CloudSyncStatus = 'signed_out' | 'loading' | 'needs_merge' | 'saved' | 'saving' | 'offline' | 'unsynced' | 'failed' | 'conflict' | 'reauthorize'
export type MergeChoice = 'local' | 'cloud'
export type MergeConflict = { collection: keyof TrackerData; id: string; cloudId: string; title: string; reason: 'changed_record' | 'possible_duplicate'; fields?: string[]; values?: Record<string, { local: unknown; cloud: unknown }>; localChanges?: Record<string, unknown> }
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

export function hasTrackerRecords(data: TrackerData): boolean { return hasRecords(data) }

/**
 * A record-level three-way merge. A difference from the cloud is only a
 * conflict when the same record field changed independently on both sides.
 * Nested values (such as sale lines) are atomic fields so accounting bundles
 * are never partially spliced together.
 */
export function threeWayMerge(baseline: TrackerData, local: TrackerData, cloud: TrackerData): MergePreview {
  const data = { ...cloud } as TrackerData
  const conflicts: MergeConflict[] = [], added: MergePreview['added'] = []
  let existing = 0
  const titleFor = (collection: keyof TrackerData, row: RecordWithId) => {
    if (collection === 'units') return records(local, 'items').find((item) => item.id === row.itemId)?.title ?? records(cloud, 'items').find((item) => item.id === row.itemId)?.title ?? titleOf(row)
    return titleOf(row)
  }
  for (const collection of collections) {
    const baseRows = records(baseline, collection), localRows = records(local, collection), cloudRows = records(cloud, collection)
    const baseById = new Map(baseRows.map((row) => [row.id, row])), localById = new Map(localRows.map((row) => [row.id, row])), cloudById = new Map(cloudRows.map((row) => [row.id, row]))
    const ids = new Set([...baseById.keys(), ...localById.keys(), ...cloudById.keys()])
    const merged: RecordWithId[] = []
    for (const id of ids) {
      const base = baseById.get(id), localRow = localById.get(id), cloudRow = cloudById.get(id)
      if (!base) {
        if (localRow && cloudRow) {
          if (serialize(localRow) === serialize(cloudRow)) { merged.push(cloudRow); existing++; continue }
          const { row, changed, conflicting } = mergeFields({}, localRow, cloudRow)
          if (conflicting.length) conflicts.push({ collection, id, cloudId: id, title: titleFor(collection, localRow), reason: 'changed_record', fields: conflicting, values: conflictValues(conflicting, localRow, cloudRow), localChanges: changed })
          merged.push(row as RecordWithId); if (!conflicting.length) added.push({ collection, id, title: titleFor(collection, row as RecordWithId) })
        } else if (localRow) { merged.push(localRow); added.push({ collection, id, title: titleFor(collection, localRow) }) }
        else if (cloudRow) merged.push(cloudRow)
        continue
      }
      if (!localRow && !cloudRow) continue
      if (!localRow || !cloudRow) {
        const survivor = localRow ?? cloudRow!
        const changedOnSurvivor = serialize(survivor) !== serialize(base)
        if (!changedOnSurvivor) continue // The other side deleted an unchanged record.
        const localDeleted = !localRow
        const changes = localDeleted ? { __recordDeleted: true } : { __recordRestore: localRow as unknown as Record<string, unknown> }
        conflicts.push({ collection, id, cloudId: id, title: titleFor(collection, survivor), reason: 'changed_record', fields: ['record deleted versus edited'], localChanges: changes })
        if (cloudRow) merged.push(cloudRow)
        continue
      }
      const { row, changed, conflicting } = mergeFields(base, localRow, cloudRow)
      merged.push(row as RecordWithId)
      if (conflicting.length) conflicts.push({ collection, id, cloudId: id, title: titleFor(collection, localRow), reason: 'changed_record', fields: conflicting, values: conflictValues(conflicting, localRow, cloudRow), localChanges: changed })
      else if (serialize(row) !== serialize(cloudRow)) added.push({ collection, id, title: titleFor(collection, row as RecordWithId) })
      else existing++
    }
    if (baseline[collection] !== undefined || local[collection] !== undefined || cloud[collection] !== undefined) (data as unknown as Record<string, unknown>)[collection] = merged
  }
  // Two devices can independently create different internal UUIDs for the
  // same imported source record. Stable external IDs identify one logical
  // record, so keep the cloud identity and remap local references to it.
  for (const collection of collections) {
    const rows = records(data, collection), groups = new Map<string, RecordWithId[]>()
    for (const row of rows) { const key = stableKey(row); if (key) groups.set(key, [...(groups.get(key) ?? []), row]) }
    for (const duplicates of groups.values()) {
      if (duplicates.length < 2) continue
      const canonical = duplicates.find((row) => records(cloud, collection).some((candidate) => candidate.id === row.id)) ?? duplicates[0]
      for (const duplicate of duplicates) {
        if (duplicate.id === canonical.id) continue
        const alignedLocal = { ...duplicate, id: canonical.id } as RecordWithId
        const { row, changed, conflicting } = mergeFields({}, alignedLocal, canonical)
        const collectionRows = records(data, collection) as Array<Record<string, unknown>>
        const canonicalIndex = collectionRows.findIndex((candidate) => candidate.id === canonical.id)
        if (canonicalIndex >= 0) collectionRows[canonicalIndex] = row
        const duplicateIndex = collectionRows.findIndex((candidate) => candidate.id === duplicate.id)
        if (duplicateIndex >= 0) collectionRows.splice(duplicateIndex, 1)
        remapDataReferences(data, collection, duplicate.id, canonical.id)
        if (conflicting.length) conflicts.push({ collection, id: duplicate.id, cloudId: canonical.id, title: titleFor(collection, duplicate), reason: 'possible_duplicate', fields: conflicting, values: conflictValues(conflicting, alignedLocal, canonical), localChanges: changed })
      }
    }
  }
  return { data, added, existing, conflicts, duplicateImports: 0 }
}

function conflictValues(fields: string[], local: RecordWithId, cloud: RecordWithId): MergeConflict['values'] {
  return Object.fromEntries(fields.map((field) => [field, { local: (local as unknown as Record<string, unknown>)[field], cloud: (cloud as unknown as Record<string, unknown>)[field] }]))
}

function mergeFields(base: Record<string, unknown>, local: Record<string, unknown>, cloud: Record<string, unknown>) {
  const row: Record<string, unknown> = {}, localChanges: Record<string, unknown> = {}, conflicting: string[] = []
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(cloud)])
  for (const key of keys) {
    const b = serialize(base[key]), l = serialize(local[key]), c = serialize(cloud[key])
    const localChanged = l !== b, cloudChanged = c !== b
    if (localChanged && cloudChanged && l !== c) { conflicting.push(key); row[key] = cloud[key]; localChanges[key] = local[key] }
    else if (localChanged && (!cloudChanged || l === c)) { if (key in local) row[key] = local[key]; localChanges[key] = local[key] }
    else if (key in cloud) row[key] = cloud[key]
  }
  return { row, changed: localChanges, conflicting }
}

export function applyThreeWayChoices(merged: TrackerData, conflicts: MergeConflict[], choices: Record<string, MergeChoice>): TrackerData {
  const result = JSON.parse(JSON.stringify(merged)) as TrackerData
  for (const conflict of conflicts) {
    const key = `${conflict.collection}:${conflict.id}`, choice = choices[key]
    if (!choice) throw new Error('Resolve every cloud merge conflict before approving the merge.')
    if (choice === 'cloud' || !conflict.localChanges) continue
    const rows = records(result, conflict.collection) as Array<Record<string, unknown>>
    const index = rows.findIndex((row) => row.id === conflict.cloudId)
    if (conflict.localChanges.__recordDeleted === true) { if (index >= 0) rows.splice(index, 1); continue }
    const restore = conflict.localChanges.__recordRestore
    if (restore && typeof restore === 'object') { if (index >= 0) rows[index] = restore as Record<string, unknown>; else rows.push(restore as Record<string, unknown>); continue }
    if (index < 0) continue
    for (const [field, value] of Object.entries(conflict.localChanges)) {
      if (field === '__recordDeleted') continue
      if (value === undefined) delete rows[index][field]
      else rows[index][field] = value
    }
  }
  return result
}

export function reconcileCloudSnapshots(baselineText: string | undefined, local: TrackerData, localRevision: number, cloud: RemoteDocument, recoveryRequired = false): { kind: 'adopt_cloud' | 'merge_local' | 'conflict' | 'recovery'; data?: TrackerData; preview?: MergePreview } {
  if (recoveryRequired || !baselineText) return { kind: 'recovery' }
  if (cloud.revision < localRevision) return { kind: 'recovery' }
  let baseline: TrackerData
  try { baseline = JSON.parse(baselineText) as TrackerData } catch { return { kind: 'recovery' } }
  const result = threeWayMerge(baseline, local, cloud.data)
  if (result.conflicts.length) return { kind: 'conflict', data: result.data, preview: result }
  if (serialize(result.data) === serialize(cloud.data)) return { kind: 'adopt_cloud', data: cloud.data, preview: result }
  return { kind: 'merge_local', data: result.data, preview: result }
}

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
