import { describe, expect, it } from 'vitest'
import { getMetrics } from './domain'
import type { TrackerData } from './domain'
import { correctExistingSale, quickSalePriceDefault, recordQuickSale } from './quickSale'

const fixture = (askingCents = 1200, quantity = 1): TrackerData => ({
  lots: [{ id: 'lot', name: 'Games', date: '2026-11-01', source: 'Outlet', purchaseCents: 500, expensesCents: 0 }],
  items: [{ id: 'game', title: 'Duplicate cartridge', category: 'Games', quantity, originalQuantity: quantity, lotId: 'lot', costCents: 500 * quantity, askingCents, platform: 'Vinted', status: 'active' }],
  units: Array.from({ length: quantity }, (_, i) => ({ id: `copy-${i + 1}`, itemId: 'game', copyNumber: i + 1, status: 'active' as const })),
  sales: [], expenses: [], credit: [], platforms: [{ id: 'vinted', name: 'Vinted', kind: 'sales' }],
})
const input = (grossCents: number, feeCents = 0) => ({ date: '2026-11-05', platform: 'Vinted', grossCents, feeCents, shippingCents: 0, otherExpenseCents: 0 })
const ids = (() => { let index = 0; return () => `new-${++index}` })()

describe('quick sale', () => {
  it('prefills with the original asking price and leaves a blank required value when absent', () => {
    expect(quickSalePriceDefault(1234)).toBe('12.34')
    expect(quickSalePriceDefault(0)).toBe('')
    expect(quickSalePriceDefault(-1)).toBe('')
  })
  it('records an asking-price sale as paid cash and updates item and lot totals immediately', () => {
    const result = recordQuickSale(fixture(), 'game', input(1200, 100), ids)
    expect(result.sale.grossCents).toBe(1200)
    expect(result.sale.paymentStatus).toBe('paid')
    expect(result.data.items[0].askingCents).toBe(1200)
    expect(result.data.items[0].quantity).toBe(0)
    expect(result.data.units?.[0].status).toBe('completed')
    expect(getMetrics(result.data).netCashProceedsCents).toBe(1100)
    expect(getMetrics(result.data).overallCashPositionCents).toBe(600)
    expect(getMetrics(result.data).realizedItemProfitCents).toBe(600)
  })

  it('accepts a lower offer without overwriting the original asking price', () => {
    const result = recordQuickSale(fixture(), 'game', input(800), ids)
    expect(result.data.items[0].askingCents).toBe(1200)
    expect(result.sale.grossCents).toBe(800)
    expect(getMetrics(result.data).netCashProceedsCents).toBe(800)
  })

  it('supports a user-entered amount when no asking price exists', () => {
    const result = recordQuickSale(fixture(0), 'game', input(450), ids)
    expect(result.sale.grossCents).toBe(450)
    expect(getMetrics(result.data).netCashProceedsCents).toBe(450)
  })

  it('tracks duplicate copies as distinct units and does not resell a completed unit', () => {
    const initial = fixture(1200, 2)
    const first = recordQuickSale(initial, 'game', input(1200), ids)
    expect(first.unit.id).toBe('copy-1')
    expect(first.data.units?.find((unit) => unit.id === 'copy-2')?.status).toBe('active')
    const second = recordQuickSale(first.data, 'game', input(900), ids)
    expect(second.unit.id).toBe('copy-2')
    expect(second.data.sales).toHaveLength(2)
    expect(() => recordQuickSale(second.data, 'game', input(900), ids)).toThrow(/no available inventory unit/)
  })

  it('rejects negative amounts and expenses that exceed gross proceeds', () => {
    expect(() => recordQuickSale(fixture(), 'game', input(-1), ids)).toThrow(/nonnegative sale amount/)
    expect(() => recordQuickSale(fixture(), 'game', { ...input(100), feeCents: 101 }, ids)).toThrow(/cannot exceed/)
  })

  it('corrects an existing sale in place without creating a duplicate transaction', () => {
    const first = recordQuickSale(fixture(), 'game', input(1200), ids)
    const corrected = correctExistingSale(first.data, first.sale.id, { date: '2026-11-05', platform: 'Local Sale', grossCents: 900, feeCents: 100, shippingCents: 0, otherExpenseCents: 0, paid: true })
    expect(corrected.sales).toHaveLength(1)
    expect(corrected.sales[0].id).toBe(first.sale.id)
    expect(corrected.sales[0].grossCents).toBe(900)
    expect(corrected.sales[0].platform).toBe('Local Sale')
    expect(getMetrics(corrected).netCashProceedsCents).toBe(800)
    expect(getMetrics(corrected).realizedItemProfitCents).toBe(300)
  })
})

