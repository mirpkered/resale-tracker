import { describe, expect, it } from 'vitest'
import { blankData } from './storage'
import { emptyInventoryFilters, filterInventoryItems, sortInventoryItems } from './inventory'
import type { TrackerData } from './domain'

function sampleData(): TrackerData {
  return {
    ...blankData(),
    lots: [{ id: 'lot-halloween', name: 'Halloween DVDs', date: '2026-10-31', source: 'Thrift store', purchaseCents: 2300, expensesCents: 0 }],
    items: [
      { id: 'joan-s2', title: 'Joan of Arcadia Season 2', description: 'DVD set', category: 'DVD', quantity: 1, lotId: 'lot-halloween', costCents: 100, askingCents: 500, platform: 'Vinted', status: 'acquired' },
      { id: 'dvd-2', title: 'Mystery Series', category: 'DVD', quantity: 2, lotId: 'lot-halloween', costCents: 200, askingCents: 700, platform: 'eBay', status: 'active' },
      { id: 'archived', title: 'Old listing', category: 'DVD', quantity: 0, lotId: null, costCents: 0, askingCents: 0, platform: 'Other', status: 'disposed', archived: true },
    ],
  }
}

describe('inventory search and filters', () => {
  it('searches item descriptions and purchase lot names while excluding archived records', () => {
    const data = sampleData()
    expect(filterInventoryItems(data, 'halloween', emptyInventoryFilters).map((item) => item.id)).toEqual(['joan-s2', 'dvd-2'])
    expect(filterInventoryItems(data, 'season 2', emptyInventoryFilters).map((item) => item.id)).toEqual(['joan-s2'])
    expect(filterInventoryItems(data, '', emptyInventoryFilters).map((item) => item.id)).toEqual(['joan-s2', 'dvd-2'])
  })

  it('combines lot, platform, category, and status filters without changing inventory records', () => {
    const data = sampleData()
    const result = filterInventoryItems(data, '', { lotId: 'lot-halloween', platform: 'eBay', category: 'DVD', status: 'active' })
    expect(result.map((item) => item.id)).toEqual(['dvd-2'])
    expect(data.items[0].status).toBe('acquired')
    expect(data.items[1].quantity).toBe(2)
  })

  it('sorts a filtered list without mutating the source order', () => {
    const data = sampleData()
    const source = filterInventoryItems(data, '', emptyInventoryFilters)
    expect(sortInventoryItems(source, 'asking_desc').map((item) => item.id)).toEqual(['dvd-2', 'joan-s2'])
    expect(source.map((item) => item.id)).toEqual(['joan-s2', 'dvd-2'])
  })
})
