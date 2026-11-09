import { describe, expect, it } from 'vitest'
import { getMetrics, type InventoryItem, type LedgerTransaction, type TrackerData } from './domain'
import { lotReconciliationStatus, summarizeLot } from './lotView'

function revision18AuditFixture(): TrackerData {
  const lots: TrackerData['lots'] = [
    { id: 'halloween', name: 'Halloween Thrift Store DVD Haul', date: '2026-10-31', source: 'Halloween thrift store sale', purchaseCents: 2300, expensesCents: 0 },
    { id: 'goodwill', name: 'Goodwill Outlet — November 2026', date: '2026-11-01', source: 'Goodwill Outlet / Goodwill Bins', purchaseCents: 10015, expensesCents: 0 },
    { id: 'yard', name: 'Yard Sale — November 7, 2026', date: '2026-11-07', source: 'Yard sale', purchaseCents: 600, expensesCents: 0, allocationRoundingAdjustmentCents: 5, notes: 'Additional DVD purchase has 47 titles remain unresolved.' },
    { id: 'japanese', name: 'Japanese Nintendo DS/3DS Import Lot', date: '', source: 'Vinted', purchaseCents: 2500, expensesCents: 0, fieldVerification: { purchaseCents: 'estimated', expensesCents: 'unknown' } },
  ]
  const items: InventoryItem[] = [
    { id: 'h-available', title: 'Halloween remaining', category: 'DVD', quantity: 17, originalQuantity: 17, lotId: 'halloween', costCents: 1700, askingCents: 0, suggestedAskingCents: 6000, platform: 'Vinted', status: 'active', fieldVerification: { costCents: 'confirmed', askingCents: 'unknown' } },
    { id: 'h-sold', title: 'Halloween sold copies', category: 'DVD', quantity: 0, originalQuantity: 2, lotId: 'halloween', costCents: 200, askingCents: 0, platform: 'Vinted', status: 'completed', fieldVerification: { costCents: 'confirmed' } },
    { id: 'h-disposed', title: 'Halloween disposed copies', category: 'DVD', quantity: 0, originalQuantity: 4, lotId: 'halloween', costCents: 400, askingCents: 0, platform: 'Other', status: 'disposed', fieldVerification: { costCents: 'confirmed' } },
    ...Array.from({ length: 37 }, (_, index): InventoryItem => ({ id: `g-listed-${index}`, title: `Goodwill listed item ${index + 1}`, category: 'Mixed', quantity: 1, originalQuantity: 1, lotId: 'goodwill', costCents: 163, askingCents: index < 16 ? 1777 : 1776, platform: 'Amazon / Vinted / eBay', status: 'active', fieldVerification: { costCents: 'estimated', askingCents: 'confirmed' } })),
    { id: 'g-available-unlisted', title: 'Goodwill unlisted stock', category: 'Mixed', quantity: 7, originalQuantity: 7, lotId: 'goodwill', costCents: 1137, askingCents: 0, platform: 'Other', status: 'acquired', fieldVerification: { costCents: 'estimated', askingCents: 'unknown' } },
    ...Array.from({ length: 14 }, (_, index): InventoryItem => ({ id: `y-original-${index}`, title: `Original yard item ${index + 1}`, category: 'DVD', quantity: 1, originalQuantity: 1, lotId: 'yard', costCents: 7, askingCents: index === 0 ? 3300 : 0, platform: 'Vinted', status: 'acquired', fieldVerification: { costCents: 'confirmed', askingCents: index === 0 ? 'confirmed' : 'unknown' } })),
    { id: 'y-sold', title: 'Yard sale sold DVD', category: 'DVD', quantity: 0, originalQuantity: 1, lotId: 'yard', costCents: 7, askingCents: 200, platform: 'Vinted', status: 'completed', fieldVerification: { costCents: 'confirmed' } },
    ...Array.from({ length: 27 }, (_, index): InventoryItem => ({ id: `y-additional-${index}`, title: `Additional DVD ${index + 1}`, category: 'DVD', quantity: 1, originalQuantity: 1, lotId: 'yard', costCents: 7, askingCents: 0, suggestedAskingCents: 300, platform: 'Vinted', status: 'acquired', fieldVerification: { costCents: 'estimated', askingCents: 'suggested' } })),
    ...Array.from({ length: 50 }, (_, index): InventoryItem => ({ id: `jp-listed-${index}`, title: `Japanese listed cartridge ${index + 1}`, category: 'Games', quantity: 1, originalQuantity: 1, lotId: 'japanese', costCents: index < 33 ? 36 : 35, askingCents: 166, platform: 'Vinted', status: 'active', fieldVerification: { costCents: 'estimated', askingCents: 'confirmed' } })),
    { id: 'jp-duplicates', title: 'Japanese duplicate cartridges', category: 'Games', quantity: 18, originalQuantity: 18, lotId: 'japanese', costCents: 646, askingCents: 0, suggestedAskingCents: 3900, platform: 'Vinted', status: 'acquired', fieldVerification: { costCents: 'estimated', askingCents: 'unknown' } },
  ]
  const ledger = (id: string, lotId: string, type: LedgerTransaction['type'], grossCents: number, receivedCents: number, feesCents = 0, shippingCents = 0, expensesCents = 0): LedgerTransaction => ({ id, externalSource: 'audit-fixture', externalId: id, type, date: '', lotId, grossCents, feesCents, shippingCents, expensesCents, receivedCents, creditCents: 0, expectedCents: 0, paymentStatus: 'confirmed', fieldVerification: { grossCents: 'confirmed', receivedCents: 'confirmed', feesCents: 'confirmed', shippingCents: 'confirmed', expensesCents: 'confirmed' } })
  const ledgerTransactions: LedgerTransaction[] = [
    ledger('h-receipts', 'halloween', 'cash_sale', 1350, 1350),
    ledger('g-receipts', 'goodwill', 'cash_sale', 7215, 6223, 380, 612),
    ledger('y-receipts', 'yard', 'cash_sale', 200, 200),
    ledger('jp-receipts', 'japanese', 'cash_sale', 950, 950),
    { ...ledger('g-credit', 'goodwill', 'store_credit', 0, 0), creditCents: 4390, creditDirection: 'issued' },
    { ...ledger('g-pending', 'goodwill', 'pending_offer', 0, 0), expectedCents: 4269, paymentStatus: 'pending', fieldVerification: { expectedCents: 'pending' } },
  ]
  return { lots, items, sales: [], expenses: [], credit: [], platforms: [], ledgerTransactions }
}

describe('revision 18 dashboard financial regression', () => {
  const data = revision18AuditFixture()

  it('separates confirmed and estimated remaining inventory cost and counts only active confirmed asks', () => {
    const metrics = getMetrics(data)
    expect(metrics.remainingQuantity).toBe(170)
    expect(metrics.remainingInventoryCostCents).toBe(1798)
    expect(metrics.unverifiedRemainingInventoryCostCents).toBe(9786)
    expect(metrics.unsoldAskingCents).toBe(74028)
    expect(metrics.storeCreditBalanceCents).toBe(4390)
    expect(metrics.pendingOfferValueCents).toBe(4269)
    expect(metrics.netCashProceedsCents).toBe(8723)
    expect(metrics.sellingExpensesCents).toBe(992)
    expect(metrics.purchaseInvestmentCents).toBe(12915)
    expect(metrics.overallCashPositionCents).toBe(-4192)
  })

  it('shows the three confirmed lot positions and the Japanese provisional position', () => {
    const summaries = data.lots.map((lot) => summarizeLot(data, lot))
    expect(summaries.map((summary) => summary.estimatedInvestment ? summary.estimatedCashPositionCents : summary.cashPositionCents)).toEqual([-950, -3792, -400, -1550])
    expect(summaries[3].cashPositionCents).toBe(950)
    expect(summaries[3].estimatedInvestment).toBe(true)
  })

  it('flags unresolved yard inventory and its unallocated purchase cost', () => {
    const status = lotReconciliationStatus(data, data.lots[2])
    expect(status.inventoryIncomplete).toBe(true)
    expect(status.unallocatedCostCents).toBe(311)
    expect(status.hasWarnings).toBe(true)
  })
})
