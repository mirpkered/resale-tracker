import { describe, expect, it } from 'vitest'
import type { InventoryItem, TrackerData } from './domain'
import { listingPriceLabel, selectGlobalListings } from './listingsView'

const fixture = (): TrackerData => {
  const items: InventoryItem[] = [
    { id: 'z-listed', title: 'Zebra DVD', category: 'DVD', lotId: 'lot-a', quantity: 1, costCents: 100, askingCents: 500, platform: 'Vinted', status: 'active' },
    { id: 'a-listed', title: 'Alpha DVD', category: 'DVD', lotId: 'lot-b', quantity: 2, costCents: 100, askingCents: 300, platform: 'eBay', status: 'active' },
    { id: 'historical', title: 'Historical ask', category: 'DVD', lotId: 'lot-a', quantity: 1, costCents: 100, askingCents: 0, suggestedAskingCents: 900, platform: '', status: 'acquired' },
    { id: 'sold', title: 'Sold title', category: 'DVD', lotId: 'lot-a', quantity: 0, originalQuantity: 1, costCents: 100, askingCents: 700, platform: 'Vinted', status: 'completed' },
    { id: 'disposed', title: 'Disposed title', category: 'DVD', lotId: 'lot-a', quantity: 0, costCents: 100, askingCents: 0, platform: '', status: 'disposed' },
    { id: 'archived', title: 'Archived title', category: 'DVD', lotId: 'lot-b', quantity: 1, costCents: 100, askingCents: 200, platform: 'Vinted', status: 'active', archived: true },
  ]
  return { lots: [{ id: 'lot-a', name: 'Halloween', date: '2026-10-31', source: 'Thrift', purchaseCents: 500, expensesCents: 0 }, { id: 'lot-b', name: 'Yard sale', date: '2026-11-07', source: 'Yard sale', purchaseCents: 100, expensesCents: 0 }], items, sales: [{ id: 'sale-1', date: '2026-11-08', platform: 'Vinted', grossCents: 350, feeCents: 0, shippingCents: 0, otherExpenseCents: 0, paymentStatus: 'paid', receivedCents: 350, refundCents: 0, creditCents: 0, itemIds: ['sold'], status: 'completed' }], expenses: [], credit: [], platforms: [] }
}

describe('global Listings view selectors', () => {
  it('defaults to active listed inventory, sorts alphabetically, and preserves individual copy quantities', () => {
    const data = fixture()
    expect(selectGlobalListings(data).map((item) => item.id)).toEqual(['a-listed', 'z-listed'])
    expect(selectGlobalListings(data)[0].quantity).toBe(2)
  })
  it('filters by state, platform, lot, and search without including archived records by default', () => {
    const data = fixture()
    expect(selectGlobalListings(data, { status: 'unlisted', search: 'historical' }).map((item) => item.id)).toEqual(['historical'])
    expect(selectGlobalListings(data, { status: 'listed', platform: 'Vinted' }).map((item) => item.id)).toEqual(['z-listed'])
    expect(selectGlobalListings(data, { status: 'all', lotId: 'lot-a' }).map((item) => item.id)).toEqual(['z-listed', 'historical', 'sold', 'disposed'])
    expect(selectGlobalListings(data, { status: 'all', showArchived: true }).map((item) => item.id)).toContain('archived')
  })
  it('does not show suggested or historical asking prices as active value and shows actual sale prices for sold items', () => {
    const data = fixture()
    const unlisted = data.items.find((item) => item.id === 'historical')!
    const sold = data.items.find((item) => item.id === 'sold')!
    expect(listingPriceLabel(data, unlisted)).toEqual({ label: 'No active asking price' })
    expect(listingPriceLabel(data, sold)).toEqual({ label: 'Actual sale price', cents: 350 })
    expect(listingPriceLabel(data, data.items[0])).toEqual({ label: 'Active asking', cents: 500 })
  })
  it('does not treat an unverified asking amount as an active price', () => {
    const item = fixture().items[0]
    item.fieldVerification = { askingCents: 'suggested' }
    expect(listingPriceLabel(fixture(), item)).toEqual({ label: 'Active listing · price unconfirmed' })
  })
})
