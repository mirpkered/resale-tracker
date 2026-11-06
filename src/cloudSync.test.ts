import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyCloudMerge, applyThreeWayChoices, GitHubCloudStorageAdapter, previewCloudMerge, reconcileCloudSnapshots, requiresCloudMergeReview, threeWayMerge } from './cloudSync'
import type { TrackerData } from './domain'
import { blankData } from './storage'
import { getMetrics } from './domain'

const localLegacyInventory = (): TrackerData => {
  const data = blankData()
  data.lots = [{ id: 'legacy-lot', externalSource: 'migration-fixture', externalId: 'legacy-lot-01', name: 'Legacy inventory lot', date: '2025-06-12', source: 'Local thrift store', purchaseCents: 1700, expensesCents: 0 }]
  data.items = Array.from({ length: 6 }, (_, index) => ({ id: `item-${index + 1}`, externalSource: 'migration-fixture', externalId: `item-${index + 1}`, title: index === 0 ? 'Series Season 2' : index < 3 ? `Unidentified item placeholder ${index}` : `Confirmed item ${index}`, description: '', category: 'Media', quantity: index >= 4 ? 0 : 1, originalQuantity: 1, lotId: 'legacy-lot', costCents: 100, askingCents: 0, platform: '', status: index >= 4 ? 'disposed' as const : 'acquired' as const }))
  data.units = data.items.map((item, index) => ({ id: `unit-${index + 1}`, externalId: `unit-${index + 1}`, itemId: item.id, copyNumber: 1, status: index >= 4 ? 'disposed' as const : item.status }))
  return data
}

describe('automatic cloud sync adapter', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('preserves a previously approved local lot and remaining units when first connecting to an empty cloud', () => {
    const local = localLegacyInventory(), cloud = blankData(), preview = previewCloudMerge(local, cloud)
    expect(requiresCloudMergeReview(local, cloud, false, true)).toBe(true)
    expect(preview.conflicts).toHaveLength(0)
    const merged = applyCloudMerge(local, cloud, preview, {})
    expect(merged.lots).toHaveLength(1)
    expect(merged.lots[0].purchaseCents).toBe(1700)
    expect(merged.items.reduce((sum, item) => sum + item.quantity, 0)).toBe(4)
    expect(merged.units).toHaveLength(6)
    expect(merged.units?.filter((unit) => unit.status === 'disposed')).toHaveLength(2)
    expect(merged.sales).toHaveLength(0)
    expect(merged.items.find((item) => item.title === 'Series Season 2')?.quantity).toBe(1)
  })

  it('requires review for an unchanged saved local workspace when the private repository is empty', () => {
    const local = localLegacyInventory(), cloud = blankData()
    expect(requiresCloudMergeReview(local, cloud, false, true)).toBe(true)
    expect(requiresCloudMergeReview(local, cloud, false, false)).toBe(false)
    expect(requiresCloudMergeReview(local, localLegacyInventory(), true, false)).toBe(false)
  })

  it('never proposes uploading an empty new device over existing cloud inventory', () => {
    expect(requiresCloudMergeReview(blankData(), localLegacyInventory(), true, false)).toBe(false)
    expect(requiresCloudMergeReview(blankData(), blankData(), false, true)).toBe(false)
  })

  it('keeps exact records once and reports changed same-ID rows as conflicts', () => {
    const local = localLegacyInventory(), cloud = localLegacyInventory()
    cloud.items[0] = { ...cloud.items[0], title: 'Cloud-edited title' }
    const preview = previewCloudMerge(local, cloud)
    expect(preview.existing).toBe(12)
    expect(preview.conflicts).toEqual([expect.objectContaining({ collection: 'items', id: 'item-1', reason: 'changed_record' })])
    expect(() => applyCloudMerge(local, cloud, preview, {})).toThrow(/Resolve every cloud merge conflict/)
    expect(applyCloudMerge(local, cloud, preview, { 'items:item-1': 'cloud' }).items[0].title).toBe('Cloud-edited title')
    expect(applyCloudMerge(local, cloud, preview, { 'items:item-1': 'local' }).items[0].title).toBe('Series Season 2')
  })

  it('flags matching source identifiers across different internal IDs as potential duplicates', () => {
    const local = blankData(), cloud = blankData()
    local.items = [{ id: 'local-item', externalSource: 'chat-source', externalId: 'dvd-1', title: 'DVD', category: 'DVDs', quantity: 1, lotId: null, costCents: 100, askingCents: 0, platform: '', status: 'acquired' }]
    cloud.items = [{ ...local.items[0], id: 'cloud-item' }]
    const preview = previewCloudMerge(local, cloud)
    expect(preview.duplicateImports).toBe(1)
    expect(preview.conflicts[0]).toMatchObject({ cloudId: 'cloud-item', id: 'local-item', reason: 'possible_duplicate' })
  })

  it('sends same-origin credentials and retries are represented by the exact same batch ID', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ document: { revision: 3 }, duplicate: true, commitSha: 'commit', syncConfirmedAt: '2026-11-04T12:00:00.000Z' }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    const batch = { format: 'resale-tracker-sync-batch' as const, schemaVersion: '1.0' as const, batchId: 'stable-batch-id', baseRevision: 2, createdAt: '2026-11-04T11:00:00.000Z', data: blankData() }
    const adapter = new GitHubCloudStorageAdapter()
    const first = await adapter.save(batch), retry = await adapter.save(batch)
    expect(first.duplicate).toBe(true); expect(retry.duplicate).toBe(true)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).batch.batchId).toBe('stable-batch-id')
    expect(fetchMock.mock.calls[0][1].credentials).toBe('same-origin')
    expect(fetchMock.mock.calls[0][1].headers['X-Resale-Request']).toBe('1')
  })

  it('does not turn an HTTP revision conflict into a successful save', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'revision_conflict', message: 'Reload and reconcile.' }), { status: 409 })))
    const batch = { format: 'resale-tracker-sync-batch' as const, schemaVersion: '1.0' as const, batchId: 'stable-conflict', baseRevision: 1, createdAt: '2026-11-04T11:00:00.000Z', data: blankData() }
    await expect(new GitHubCloudStorageAdapter().save(batch)).rejects.toMatchObject({ status: 409, kind: 'revision_conflict' })
  })

  it('keeps authentication expiry distinct from an authenticated session restoration', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: true, login: 'resale-owner', expiresAt: 1_800_000_000_000 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new GitHubCloudStorageAdapter()
    expect(await adapter.session()).toBeNull()
    expect(await adapter.session()).toMatchObject({ authenticated: true, login: 'resale-owner' })
  })

  it('keeps edits and the exact retry batch after an interrupted cloud write', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ document: { revision: 1 }, duplicate: false, commitSha: 'verified', syncConfirmedAt: '2026-11-05T00:00:00Z' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new GitHubCloudStorageAdapter(), batch = { format: 'resale-tracker-sync-batch' as const, schemaVersion: '1.0' as const, batchId: 'retry-same-batch', baseRevision: 0, createdAt: '2026-11-05T00:00:00Z', data: localLegacyInventory() }
    await expect(adapter.save(batch)).rejects.toMatchObject({ status: 503 })
    const saved = await adapter.save(batch)
    expect(saved.document.revision).toBe(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).batch.batchId).toBe(JSON.parse(fetchMock.mock.calls[1][1].body).batch.batchId)
  })

  it('merges independently added device records without duplicates or revision churn', () => {
    const baseline = blankData(), local = blankData(), cloud = blankData()
    local.items = [{ id: 'local-new-item', externalSource: 'project-chat', externalId: 'dvd-copy-1', title: 'DVD copy 1', category: 'DVD', quantity: 1, lotId: null, costCents: 100, askingCents: 300, platform: '', status: 'acquired' }]
    cloud.items = [{ id: 'cloud-new-item', externalSource: 'project-chat', externalId: 'dvd-copy-2', title: 'DVD copy 2', category: 'DVD', quantity: 1, lotId: null, costCents: 100, askingCents: 300, platform: '', status: 'acquired' }]
    const result = threeWayMerge(baseline, local, cloud)
    expect(result.conflicts).toHaveLength(0)
    expect(result.data.items).toHaveLength(2)
    expect(threeWayMerge(baseline, result.data, cloud).data.items).toHaveLength(2)
  })

  it('deduplicates separately generated internal IDs for the same stable import identifier', () => {
    const baseline = blankData(), local = blankData(), cloud = blankData()
    const source = { externalSource: 'chat-import', externalId: 'dvd-copy-17', title: 'Duplicate-safe DVD', category: 'DVD', quantity: 1, lotId: null, costCents: 100, askingCents: 300, platform: '', status: 'acquired' as const }
    local.items = [{ ...source, id: 'device-a-id' }]
    local.units = [{ id: 'device-a-unit', externalId: 'unit-17', itemId: 'device-a-id', copyNumber: 1, status: 'acquired' }]
    cloud.items = [{ ...source, id: 'device-b-id' }]
    cloud.units = [{ id: 'device-b-unit', externalId: 'unit-17', itemId: 'device-b-id', copyNumber: 1, status: 'acquired' }]
    const result = threeWayMerge(baseline, local, cloud)
    expect(result.data.items).toHaveLength(1)
    expect(result.data.items[0].id).toBe('device-b-id')
    expect(result.data.units).toHaveLength(1)
    expect(result.data.units?.[0].itemId).toBe('device-b-id')
  })

  it('automatically adopts cloud revision 4 when revision 3 local data matches its saved baseline', () => {
    const local = localLegacyInventory(), cloud = localLegacyInventory()
    cloud.items[0] = { ...cloud.items[0], title: 'Reconciled title' }
    cloud.items[1] = { ...cloud.items[1], title: 'Reconciled second title' }
    cloud.units = cloud.units?.map((unit, index) => index === 0 ? { ...unit, status: 'active' as const } : unit)
    const plan = reconcileCloudSnapshots(JSON.stringify(local), local, 3, { schemaVersion: '2.0', revision: 4, updatedAt: '2026-11-05T00:00:00Z', importedBatches: [], data: cloud })
    expect(plan.kind).toBe('adopt_cloud')
    expect(plan.preview?.conflicts).toHaveLength(0)
    expect(plan.data?.items[0].title).toBe('Reconciled title')
    expect(plan.data?.items[1].title).toBe('Reconciled second title')
  })

  it('merges local and cloud edits to different fields of the same record', () => {
    const baseline = localLegacyInventory(), local = localLegacyInventory(), cloud = localLegacyInventory()
    local.items[0] = { ...local.items[0], notes: 'Edited on this device' }
    cloud.items[0] = { ...cloud.items[0], askingCents: 599 }
    const result = threeWayMerge(baseline, local, cloud)
    expect(result.conflicts).toHaveLength(0)
    expect(result.data.items[0]).toMatchObject({ notes: 'Edited on this device', askingCents: 599 })
  })

  it('safely combines a local edit with a cloud-only change to another record', () => {
    const baseline = localLegacyInventory(), local = localLegacyInventory(), cloud = localLegacyInventory()
    local.items[0] = { ...local.items[0], notes: 'Only edited on this device' }
    cloud.items[3] = { ...cloud.items[3], title: 'Cloud-only updated identity' }
    const result = threeWayMerge(baseline, local, cloud)
    expect(result.conflicts).toHaveLength(0)
    expect(result.data.items[0].notes).toBe('Only edited on this device')
    expect(result.data.items[3].title).toBe('Cloud-only updated identity')
  })

  it('keeps an overlapping same-field edit as a genuine conflict and applies only the selected field', () => {
    const baseline = localLegacyInventory(), local = localLegacyInventory(), cloud = localLegacyInventory()
    local.items[0] = { ...local.items[0], title: 'Local title' }
    cloud.items[0] = { ...cloud.items[0], title: 'Cloud title', askingCents: 450 }
    const result = threeWayMerge(baseline, local, cloud)
    expect(result.conflicts).toEqual([expect.objectContaining({ collection: 'items', id: 'item-1', fields: ['title'] })])
    expect(result.conflicts[0].values?.title).toEqual({ local: 'Local title', cloud: 'Cloud title' })
    expect(applyThreeWayChoices(result.data, result.conflicts, { 'items:item-1': 'local' }).items[0]).toMatchObject({ title: 'Local title', askingCents: 450 })
  })

  it('queues a local-only edit when cloud data is unchanged from baseline', () => {
    const baseline = localLegacyInventory(), local = localLegacyInventory()
    local.items[0] = { ...local.items[0], notes: 'Local note' }
    const plan = reconcileCloudSnapshots(JSON.stringify(baseline), local, 3, { schemaVersion: '2.0', revision: 3, updatedAt: '2026-11-05T00:00:00Z', importedBatches: [], data: baseline })
    expect(plan.kind).toBe('merge_local')
    expect(plan.data?.items[0].notes).toBe('Local note')
  })

  it('requests a single recovery choice when a baseline is missing or cloud revision is stale', () => {
    const data = localLegacyInventory(), cloud = { schemaVersion: '2.0' as const, revision: 4, updatedAt: '2026-11-05T00:00:00Z', importedBatches: [], data }
    expect(reconcileCloudSnapshots(undefined, data, 3, cloud).kind).toBe('recovery')
    expect(reconcileCloudSnapshots(JSON.stringify(data), data, 5, cloud).kind).toBe('recovery')
  })

  it('preserves accounting totals when a cloud snapshot is adopted', () => {
    const data = blankData()
    data.lots = [{ id: 'verified-lot', name: 'Personal lot', date: '2026-10-31', source: 'Thrift store', purchaseCents: 2300, expensesCents: 0 }]
    data.items = Array.from({ length: 23 }, (_, index) => ({ id: `unit-item-${index}`, title: `DVD ${index}`, description: '', category: 'DVD', quantity: index < 4 ? 0 : 1, originalQuantity: 1, lotId: 'verified-lot', costCents: 100, askingCents: 0, platform: '', status: index < 4 ? 'disposed' as const : 'acquired' as const }))
    const cloud = { schemaVersion: '2.0' as const, revision: 4, updatedAt: '2026-11-05T00:00:00Z', importedBatches: [], data }
    const plan = reconcileCloudSnapshots(JSON.stringify(blankData()), blankData(), 3, cloud)
    expect(plan.kind).toBe('adopt_cloud')
    const metrics = getMetrics(plan.data!)
    expect(metrics.purchaseInvestmentCents).toBe(2300)
    expect(metrics.remainingQuantity).toBe(19)
    expect(metrics.remainingInventoryCostCents).toBe(1900)
    expect(metrics.netCashProceedsCents).toBe(0)
    expect(metrics.overallCashPositionCents).toBe(-2300)
  })
})
