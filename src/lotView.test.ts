import { describe, expect, it } from 'vitest'
import type { InventoryItem, TrackerData } from './domain'
import { getMetrics } from './domain'
import { PRIMARY_NAVIGATION, sortLotInventoryItems, summarizeLot } from './lotView'

const sampleInventory = (): TrackerData => {
  const items = [
    { id: 'item-a', title: 'Season set A', category: 'TV DVD', quantity: 1, originalQuantity: 1, lotId: 'lot-a', costCents: 300, askingCents: 700, platform: '', status: 'acquired' as const },
    { id: 'item-b', title: 'Season set B', category: 'TV DVD', quantity: 0, originalQuantity: 1, lotId: 'lot-a', costCents: 300, askingCents: 0, platform: '', status: 'disposed' as const },
    { id: 'item-c', title: 'Season set A', category: 'TV DVD', quantity: 1, originalQuantity: 1, lotId: 'lot-a', costCents: 300, askingCents: 600, platform: '', status: 'active' as const },
  ]
  return {
    lots: [{ id: 'lot-a', name: 'Sample media lot', date: '2026-10-01', source: 'Thrift store', purchaseCents: 900, expensesCents: 0 }],
    items,
    units: items.map((item, index) => ({ id: `unit-${index + 1}`, itemId: item.id, copyNumber: 1, status: item.status })),
    sales: [], expenses: [], credit: [], platforms: [],
  }
}

describe('lot-first inventory view', () => {
  it('uses only Dashboard, Lots, and Settings as primary navigation', () => {
    expect(PRIMARY_NAVIGATION).toEqual(['Dashboard', 'Lots', 'Settings'])
  })

  it('summarizes lot unit counts and confirmed net cash', () => {
    const data = sampleInventory()
    const item = data.items[0]
    data.sales.push({ id: 'sale-a', date: '2026-10-02', platform: 'Local Sale', grossCents: 400, feeCents: 20, shippingCents: 0, otherExpenseCents: 0, paymentStatus: 'paid', receivedCents: 380, refundCents: 0, creditCents: 0, itemIds: [item.id], lines: [{ itemId: item.id, quantity: 1, allocatedCostCents: 300, proceedsCents: 380, unitIds: ['unit-1'] }], status: 'completed', fieldVerification: { grossCents: 'confirmed', receivedCents: 'confirmed' } })
    item.quantity = 0
    item.status = 'completed'
    data.units![0].status = 'completed'
    const summary = summarizeLot(data, data.lots[0])
    expect(summary.purchased).toBe(3)
    expect(summary.sold).toBe(1)
    expect(summary.remaining).toBe(1)
    expect(summary.grossConfirmedSalesCents).toBe(400)
    expect(summary.cashReceivedCents).toBe(380)
    expect(summary.cashPositionCents).toBe(-520)
  })

  it('preserves disposed inventory cost and excludes it from remaining inventory', () => {
    const data = sampleInventory()
    const summary = summarizeLot(data, data.lots[0])
    const metrics = getMetrics(data)
    expect(summary.purchased).toBe(3)
    expect(summary.sold).toBe(0)
    expect(summary.remaining).toBe(2)
    expect(metrics.purchaseInvestmentCents).toBe(900)
    expect(metrics.netCashProceedsCents).toBe(0)
    expect(metrics.overallCashPositionCents).toBe(-900)
    expect(metrics.remainingInventoryCostCents).toBe(600)
  })

  it('retains separate inventory records and unit IDs for identical titles', () => {
    const data = sampleInventory()
    expect(data.items.filter((item) => item.title === 'Season set A')).toHaveLength(2)
    expect(data.items[0].id).not.toBe(data.items[2].id)
    expect(data.units?.filter((unit) => ['item-a', 'item-c'].includes(unit.itemId))).toHaveLength(2)
  })

  it('sorts listed, other available, sold, then disposed with stable order and no source mutation', () => {
    const data = sampleInventory()
    const source = [
      { ...data.items[1], status: 'disposed' as const },
      { ...data.items[0], id: 'unlisted', status: 'acquired' as const },
      { ...data.items[2], id: 'listed-a', status: 'active' as const, platform: 'Vinted' },
      { ...data.items[0], id: 'sold', status: 'completed' as const, quantity: 0 },
      { ...data.items[2], id: 'listed-b', status: 'active' as const, platform: 'eBay' },
      { ...data.items[0], id: 'listed-partial', status: 'active' as const, platform: 'Vinted', quantity: 1, originalQuantity: 2 },
    ]
    const result = sortLotInventoryItems(source)
    expect(result.map((item) => item.id)).toEqual(['listed-a', 'listed-b', 'listed-partial', 'unlisted', 'sold', 'item-b'])
    expect(source.map((item) => item.id)).toEqual(['item-b', 'unlisted', 'listed-a', 'sold', 'listed-b', 'listed-partial'])
  })

  it('reorders immediately when an available item becomes sold or disposed', () => {
    const items: InventoryItem[] = [
      { ...sampleInventory().items[0], id: 'first', status: 'acquired' as const },
      { ...sampleInventory().items[0], id: 'second', status: 'active' as const, platform: 'Vinted' },
    ]
    expect(sortLotInventoryItems(items).map((item) => item.id)).toEqual(['second', 'first'])
    items[0].status = 'completed'
    expect(sortLotInventoryItems(items).map((item) => item.id)).toEqual(['second', 'first'])
    items[0].status = 'disposed'
    expect(sortLotInventoryItems(items).map((item) => item.id)).toEqual(['second', 'first'])
    items[1].status = 'disposed'
    expect(sortLotInventoryItems(items).map((item) => item.id)).toEqual(['first', 'second'])
  })

  it('does not subtract estimated acquisition cost from a cash position', () => {
    const data = sampleInventory()
    data.lots[0].fieldVerification = { purchaseCents: 'estimated' }
    expect(summarizeLot(data, data.lots[0]).cashPositionCents).toBe(0)
  })

  it('keeps a historical suggested price out of confirmed asking value and cash proceeds', () => {
    const data = sampleInventory()
    data.items[0].askingCents = 0
    data.items[0].suggestedAskingCents = 800
    expect(getMetrics(data).suggestedAskingValueCents).toBe(800)
    expect(getMetrics(data).unsoldAskingCents).toBe(600)
    expect(getMetrics(data).netCashProceedsCents).toBe(0)
    expect(getMetrics(data).realizedItemProfitCents).toBe(0)
  })
})
