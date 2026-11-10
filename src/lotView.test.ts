import { describe, expect, it } from 'vitest'
import type { InventoryItem, TrackerData } from './domain'
import { getMetrics } from './domain'
import { itemSales, PRIMARY_NAVIGATION, realizedLotProfitCents, sortLotInventoryItems, summarizeLot } from './lotView'

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

  it('sorts listed, other available, sold, then disposed with title and ID order without mutating source', () => {
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

  it('sorts alphabetically within each group and uses stable IDs for equal titles',()=>{
    const base=sampleInventory().items[0]
    const source:InventoryItem[]=[
      {...base,id:'z',title:'Zebra',status:'active',platform:'Vinted'},
      {...base,id:'disposed-z',title:'Zebra disposed',status:'disposed',quantity:0},
      {...base,id:'listed-b',title:'Alpha',status:'active',platform:'Vinted'},
      {...base,id:'listed-a',title:'Alpha',status:'active',platform:'eBay'},
      {...base,id:'unlisted',title:'Beta',status:'acquired'},
      {...base,id:'sold',title:'Aardvark sold',status:'completed',quantity:0},
      {...base,id:'partial',title:'Zulu partial',status:'completed',quantity:1,originalQuantity:2},
    ]
    expect(sortLotInventoryItems(source).map((item)=>item.id)).toEqual(['listed-a','listed-b','z','unlisted','partial','sold','disposed-z'])
    expect(source.map((item)=>item.id)[0]).toBe('z')
  })

  it('does not subtract estimated acquisition cost from a cash position', () => {
    const data = sampleInventory()
    data.lots[0].fieldVerification = { purchaseCents: 'estimated' }
    expect(summarizeLot(data, data.lots[0]).cashPositionCents).toBe(0)
  })

  it('shows estimated investment cash recovery separately from confirmed cash position', () => {
    const data = sampleInventory()
    data.lots[0].purchaseCents = 2500
    data.lots[0].fieldVerification = { purchaseCents: 'estimated', expensesCents: 'unknown' }
    data.items[0].externalId = 'jp-game-a'
    data.ledgerTransactions = [{ id: 'jp-bundle', externalSource: 'migration', externalId: 'jp-bundle', type: 'cash_sale', date: '', platform: 'Vinted', lotId: 'lot-a', grossCents: 950, feesCents: 0, expensesCents: 0, receivedCents: 950, creditCents: 0, expectedCents: 0, paymentStatus: 'confirmed', itemExternalIds: ['jp-game-a'], itemQuantities: [1], fieldVerification: { receivedCents: 'confirmed' } }]
    const summary = summarizeLot(data, data.lots[0])
    expect(summary.cashPositionCents).toBe(950)
    expect(summary.estimatedInvestment).toBe(true)
    expect(summary.estimatedCashPositionCents).toBe(-1550)
  })

  it('includes lot-linked buyback cash while keeping lot store credit separate', () => {
    const data = sampleInventory()
    data.items[0].externalId = 'sample-a'
    data.ledgerTransactions = [
      { id: 'cash-a', externalSource: 'migration', externalId: 'cash-a', type: 'buyback_payout', date: '2026-11-04', platform: 'Half Price Books', lotId: 'lot-a', grossCents: 206, feesCents: 0, expensesCents: 0, receivedCents: 206, creditCents: 0, expectedCents: 0, paymentStatus: 'confirmed', itemExternalIds: ['sample-a'], itemQuantities: [1], fieldVerification: { grossCents: 'confirmed', receivedCents: 'confirmed' } },
      { id: 'credit-a', externalSource: 'migration', externalId: 'credit-a', type: 'store_credit', date: '2026-11-04', platform: 'Vintage Stock', lotId: 'lot-a', grossCents: 0, feesCents: 0, expensesCents: 0, receivedCents: 0, creditCents: 720, creditDirection: 'issued', expectedCents: 0, paymentStatus: 'confirmed', fieldVerification: { creditCents: 'confirmed' } },
      { id: 'pending-a', externalSource: 'migration', externalId: 'pending-a', type: 'pending_offer', date: '', platform: 'World of Books', lotId: 'lot-a', grossCents: 0, feesCents: 0, expensesCents: 0, receivedCents: 0, creditCents: 0, expectedCents: 4269, paymentStatus: 'pending', fieldVerification: { expectedCents: 'pending' } },
    ]
    const summary = summarizeLot(data, data.lots[0])
    expect(summary.cashReceivedCents).toBe(206)
    expect(summary.grossConfirmedSalesCents).toBe(206)
    expect(summary.storeCreditReceivedCents).toBe(720)
    expect(summary.pendingOfferCents).toBe(4269)
    expect(summary.cashPositionCents).toBe(-694)
    expect(getMetrics(data).netCashProceedsCents).toBe(206)
    expect(getMetrics(data).storeCreditBalanceCents).toBe(720)
    expect(getMetrics(data).pendingOfferValueCents).toBe(4269)
    const pendingGross = itemSales(data, data.items[0])[0]
    expect(pendingGross.grossCents).toBe(206)
    expect(getMetrics({ ...data, ledgerTransactions: [{ ...data.ledgerTransactions![0], externalId: 'unpaid-sale', type: 'cash_sale', grossCents: 2000, receivedCents: 0, expectedCents: 0, paymentStatus: 'pending', itemExternalIds: [data.items[0].externalId!], itemQuantities: [1], fieldVerification: { grossCents: 'confirmed', expectedCents: 'unknown' } }] }).expectedFutureProceedsCents).toBe(0)
  })

  it('counts verified migrated item profit in the correct lot only after cash confirmation', () => {
    const data = sampleInventory()
    data.items[0].externalId = 'golf'
    data.ledgerTransactions = [{ id: 'payout', externalSource: 'migration', externalId: 'payout', type: 'buyback_payout', date: '2026-11-01', platform: 'Play It Again Sports', lotId: 'lot-a', grossCents: 2000, feesCents: 0, expensesCents: 0, receivedCents: 2000, creditCents: 0, expectedCents: 0, paymentStatus: 'confirmed', itemExternalIds: ['golf'], itemQuantities: [1], saleAllocatedCostCents: [900], saleAllocatedProceedsCents: [2000], saleCostVerified: [true], fieldVerification: { receivedCents: 'confirmed' } }]
    expect(realizedLotProfitCents(data, 'lot-a')).toBe(1100)
    expect(realizedLotProfitCents(data, 'other-lot')).toBe(0)
    data.ledgerTransactions[0].paymentStatus = 'pending'
    expect(realizedLotProfitCents(data, 'lot-a')).toBe(0)
  })

  it('shows an unallocated bundle total without presenting it as an individual item price', () => {
    const data = sampleInventory()
    data.items[0].externalId = 'bundle-copy-a'
    data.items[2].externalId = 'bundle-copy-b'
    data.ledgerTransactions = [{ id: 'bundle-sale', externalSource: 'migration', externalId: 'bundle-sale', type: 'cash_sale', date: '', platform: 'Vinted', lotId: 'lot-a', grossCents: 950, feesCents: 0, shippingCents: 0, expensesCents: 0, receivedCents: 950, creditCents: 0, expectedCents: 0, paymentStatus: 'confirmed', itemExternalIds: ['bundle-copy-a', 'bundle-copy-b'], itemQuantities: [1, 1], itemUnitIds: [['unit-1'], ['unit-3']], saleAllocatedCostCents: [300, 300], saleCostVerified: [true, true], fieldVerification: { grossCents: 'confirmed', receivedCents: 'confirmed' } }]
    const details = itemSales(data, data.items[0])[0]
    expect(details.grossCents).toBe(950)
    expect(details.proceedsAllocated).toBe(false)
    expect(summarizeLot(data, data.lots[0]).cashReceivedCents).toBe(950)
    expect(realizedLotProfitCents(data, 'lot-a')).toBe(0)
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
