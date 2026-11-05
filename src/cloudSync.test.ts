import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyCloudMerge, GitHubCloudStorageAdapter, previewCloudMerge, requiresCloudMergeReview } from './cloudSync'
import type { TrackerData } from './domain'
import { blankData } from './storage'

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
})
