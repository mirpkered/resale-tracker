import { describe, expect, it } from 'vitest'
import type { TrackerData } from './domain'
import { getMetrics } from './domain'
import { PRIMARY_NAVIGATION, summarizeLot } from './lotView'

const halloween = (): TrackerData => {
  const items = Array.from({ length: 23 }, (_, index) => ({
    id: `dvd-${String(index + 1).padStart(2, '0')}`,
    title: index === 1 ? 'Joan of Arcadia Season 2' : index < 3 ? `DVD season set ${index + 1}` : `Unidentified DVD ${index - 2}`,
    category: 'DVD', quantity: index < 19 ? 1 : 0, originalQuantity: 1, lotId: 'lot-halloween',
    costCents: 100, askingCents: 0, platform: 'Other', status: index < 19 ? 'acquired' as const : 'disposed' as const,
  }))
  return {
    lots: [{ id: 'lot-halloween', name: 'Halloween DVD Haul', date: '2026-10-31', source: 'Thrift store', purchaseCents: 2300, expensesCents: 0 }],
    items,
    units: items.map((item, index) => ({ id: `unit-${index + 1}`, itemId: item.id, copyNumber: 1, status: item.status })),
    sales: [], expenses: [], credit: [], platforms: [],
  }
}

describe('lot-first inventory view', () => {
  it('uses only Dashboard, Lots, and Settings as primary navigation', () => {
    expect(PRIMARY_NAVIGATION).toEqual(['Dashboard', 'Lots', 'Settings'])
  })

  it('summarizes lot counts and confirmed cash received', () => {
    const data = halloween()
    const item = data.items[0]
    data.sales.push({ id: 'sale-1', date: '2026-11-02', platform: 'Vinted', grossCents: 400, feeCents: 20, shippingCents: 0, otherExpenseCents: 0, paymentStatus: 'paid', receivedCents: 380, refundCents: 0, creditCents: 0, itemIds: [item.id], lines: [{ itemId: item.id, quantity: 1, allocatedCostCents: 100, proceedsCents: 380, unitIds: ['unit-1'] }], status: 'completed', fieldVerification: { grossCents: 'confirmed', receivedCents: 'confirmed' } })
    item.quantity = 0
    item.status = 'completed'
    data.units![0].status = 'completed'
    const summary = summarizeLot(data, data.lots[0])
    expect(summary.purchased).toBe(23)
    expect(summary.sold).toBe(1)
    expect(summary.remaining).toBe(18)
    expect(summary.grossConfirmedSalesCents).toBe(400)
    expect(summary.cashReceivedCents).toBe(380)
    expect(summary.cashPositionCents).toBe(-1920)
  })

  it('preserves the Halloween baseline: 23 original units, 4 disposed, no sales, and $23 investment', () => {
    const data = halloween()
    const before = structuredClone(data)
    const summary = summarizeLot(data, data.lots[0])
    const metrics = getMetrics(data)
    expect(summary.purchased).toBe(23)
    expect(summary.sold).toBe(0)
    expect(summary.remaining).toBe(19)
    expect(data.units?.filter((unit) => unit.status === 'disposed')).toHaveLength(4)
    expect(metrics.purchaseInvestmentCents).toBe(2300)
    expect(metrics.netCashProceedsCents).toBe(0)
    expect(metrics.overallCashPositionCents).toBe(-2300)
    expect(data.items.find((item) => item.title === 'Joan of Arcadia Season 2')?.status).toBe('acquired')
    expect(data).toEqual(before)
  })

  it('keeps duplicate copies as separate units while showing item quantity', () => {
    const data = halloween()
    data.items[0].quantity = 2
    data.items[0].originalQuantity = 2
    data.units?.push({ id: 'unit-copy-2', itemId: data.items[0].id, copyNumber: 2, status: 'active' })
    const summary = summarizeLot(data, data.lots[0])
    expect(data.units?.filter((unit) => unit.itemId === data.items[0].id).map((unit) => unit.id)).toEqual(['unit-1', 'unit-copy-2'])
    expect(summary.purchased).toBe(24)
    expect(summary.remaining).toBe(20)
  })
})
