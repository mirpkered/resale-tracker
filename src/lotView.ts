import { ACTIVE_STATUSES, allocateCents, isFieldConfirmed, lineNetProceedsCents, receivedCashCents, retainedCostCents, type InventoryItem, type LedgerTransaction, type PurchaseLot, type Sale, type TrackerData } from './domain'

export const PRIMARY_NAVIGATION = ['Dashboard', 'Lots', 'Settings'] as const

const SOLD_STATUSES = new Set(['awaiting_payment', 'awaiting_fulfillment', 'completed'])
const END_STATUSES = new Set(['retained', 'traded', 'donated'])

/** Presentation-only stable ordering for a lot's inventory. Never mutates TrackerData.items. */
export function sortLotInventoryItems(items: InventoryItem[]): InventoryItem[] {
  return items.map((item, index) => ({ item, index, group: item.status === 'disposed' ? 4
    : SOLD_STATUSES.has(item.status) ? 2
      : END_STATUSES.has(item.status) ? 3
        : ACTIVE_STATUSES.includes(item.status) && item.quantity > 0 && item.status === 'active' && item.platform.trim() ? 0
          : ACTIVE_STATUSES.includes(item.status) && item.quantity > 0 ? 1 : 3
  })).sort((a, b) => a.group - b.group || a.index - b.index).map(({ item }) => item)
}

export interface LotSummary {
  lot: PurchaseLot
  purchased: number
  sold: number
  remaining: number
  grossConfirmedSalesCents: number
  cashReceivedCents: number
  storeCreditReceivedCents: number
  pendingOfferCents: number
  cashPositionCents: number
  estimatedCashPositionCents: number
  estimatedInvestment: boolean
  itemCount: number
}

const grossForLine = (sale: Sale, lineIndex: number): number => {
  const lines = sale.lines ?? []
  const weights = lines.map((line) => line.proceedsCents ?? line.allocatedCostCents)
  return allocateCents(sale.grossCents, weights)[lineIndex] ?? 0
}

const saleGrossForItem = (sale: Sale, itemId: string): number => {
  const lines = sale.lines ?? []
  if (lines.length) return lines.reduce((sum, line, index) => sum + (line.itemId === itemId ? grossForLine(sale, index) : 0), 0)
  const indexes = sale.itemIds.map((id, index) => id === itemId ? index : -1).filter((index) => index >= 0)
  return allocateCents(sale.grossCents, sale.itemIds.map(() => 1)).reduce((sum, cents, index) => sum + (indexes.includes(index) ? cents : 0), 0)
}

function ledgerLotAmounts(data: TrackerData, lotId: string, externalIds: Set<string>) {
  let grossCents = 0, cashCents = 0, creditCents = 0, pendingCents = 0, sold = 0
  for (const entry of data.ledgerTransactions ?? []) {
    const directLotMatch = entry.lotId === lotId
    if (entry.type === 'store_credit' && directLotMatch && entry.paymentStatus === 'confirmed' && entry.creditDirection !== 'redeemed' && isFieldConfirmed(entry, 'creditCents')) creditCents += entry.creditCents
    if (entry.type === 'pending_offer' && directLotMatch && entry.paymentStatus !== 'confirmed') pendingCents += entry.expectedCents
    if (!['cash_sale', 'buyback_payout'].includes(entry.type)) continue
    const matchingIndexes = (entry.itemExternalIds ?? []).map((id, index) => externalIds.has(id) ? index : -1).filter((index) => index >= 0)
    if (!matchingIndexes.length && !directLotMatch) continue
    if (directLotMatch && !matchingIndexes.length) {
      if (isFieldConfirmed(entry, 'grossCents')) grossCents += entry.grossCents
      if (entry.paymentStatus === 'confirmed' && isFieldConfirmed(entry, 'receivedCents')) cashCents += entry.receivedCents
      continue
    }
    const quantityWeights = entry.itemQuantities ?? matchingIndexes.map(() => 1)
    const grossShares = allocateCents(entry.grossCents, quantityWeights)
    if (isFieldConfirmed(entry, 'grossCents')) grossCents += matchingIndexes.reduce((sum, index) => sum + (grossShares[index] ?? 0), 0)
    if (entry.paymentStatus === 'confirmed' && isFieldConfirmed(entry, 'receivedCents')) {
      cashCents += matchingIndexes.reduce((sum, index) => sum + (allocateCents(entry.receivedCents, quantityWeights)[index] ?? 0), 0)
    }
    sold += matchingIndexes.reduce((sum, index) => sum + (entry.itemQuantities?.[index] ?? 0), 0)
  }
  return { grossCents, cashCents, creditCents, pendingCents, sold }
}

export function summarizeLot(data: TrackerData, lot: PurchaseLot): LotSummary {
  const items = data.items.filter((item) => item.lotId === lot.id)
  const itemIds = new Set(items.map((item) => item.id))
  const externalIds = new Set(items.map((item) => item.externalId).filter((value): value is string => Boolean(value)))
  let purchased = 0, remaining = 0, sold = 0, grossConfirmedSalesCents = 0, cashReceivedCents = 0
  for (const item of items) {
    const units = (data.units ?? []).filter((unit) => unit.itemId === item.id)
    purchased += units.length ? units.length : item.originalQuantity ?? item.quantity
    if (ACTIVE_STATUSES.includes(item.status)) remaining += item.quantity
  }
  for (const sale of data.sales) {
    const lines = sale.lines ?? []
    if (lines.length) {
      lines.forEach((line, index) => {
        if (!itemIds.has(line.itemId)) return
        sold += Math.max(0, line.quantity - (line.returnedQuantity ?? 0))
        if (sale.paymentStatus !== 'unpaid' && isFieldConfirmed(sale, 'grossCents')) grossConfirmedSalesCents += grossForLine(sale, index)
        if (isFieldConfirmed(sale, 'receivedCents')) {
          const weights = lines.map((entry) => lineNetProceedsCents(sale, entry))
          cashReceivedCents += allocateCents(receivedCashCents(sale), weights)[index] ?? 0
        }
      })
    } else {
      const linked = sale.itemIds.filter((id) => itemIds.has(id))
      if (!linked.length) continue
      sold += linked.length
      if (sale.paymentStatus !== 'unpaid' && isFieldConfirmed(sale, 'grossCents')) grossConfirmedSalesCents += allocateCents(sale.grossCents, sale.itemIds.map(() => 1)).filter((_, index) => itemIds.has(sale.itemIds[index])).reduce((a, b) => a + b, 0)
      if (isFieldConfirmed(sale, 'receivedCents')) cashReceivedCents += allocateCents(receivedCashCents(sale), sale.itemIds.map(() => 1)).filter((_, index) => itemIds.has(sale.itemIds[index])).reduce((a, b) => a + b, 0)
    }
  }
  const ledger = ledgerLotAmounts(data, lot.id, externalIds)
  sold += ledger.sold
  grossConfirmedSalesCents += ledger.grossCents
  cashReceivedCents += ledger.cashCents
  const storeCreditReceivedCents = ledger.creditCents
  const pendingOfferCents = ledger.pendingCents
  const cost = (isFieldConfirmed(lot, 'purchaseCents') ? lot.purchaseCents : 0) + (isFieldConfirmed(lot, 'expensesCents') ? lot.expensesCents : 0)
  const estimatedInvestment = !isFieldConfirmed(lot, 'purchaseCents') || !isFieldConfirmed(lot, 'expensesCents')
  return { lot, purchased, sold, remaining, grossConfirmedSalesCents, cashReceivedCents, storeCreditReceivedCents, pendingOfferCents, cashPositionCents: cashReceivedCents - cost, estimatedCashPositionCents: cashReceivedCents - lot.purchaseCents - lot.expensesCents, estimatedInvestment, itemCount: items.length }
}

export interface ItemSaleRecord { sale: Sale; grossCents: number; quantity: number; proceedsAllocated: boolean }

export function itemSales(data: TrackerData, item: InventoryItem): ItemSaleRecord[] {
  const recorded = data.sales.flatMap((sale) => {
    const lines = sale.lines ?? []
    const lineIndexes = lines.map((line, index) => line.itemId === item.id ? index : -1).filter((index) => index >= 0)
    const gross = lineIndexes.reduce((sum, index) => sum + grossForLine(sale, index), 0)
    if (gross || sale.itemIds.includes(item.id)) return [{ sale, grossCents: lines.length ? gross : saleGrossForItem(sale, item.id), quantity: lines.filter((line) => line.itemId === item.id).reduce((sum, line) => sum + line.quantity, 0) || 1, proceedsAllocated: true }]
    return []
  })
  const migrated = (data.ledgerTransactions ?? []).flatMap((entry) => {
    const index = entry.itemExternalIds?.findIndex((id) => id === item.externalId) ?? -1
    if (index < 0 || !['cash_sale', 'buyback_payout'].includes(entry.type)) return []
    const quantities = entry.itemQuantities ?? entry.itemExternalIds?.map(() => 1) ?? []
    const quantity = quantities[index] ?? 1
    const proceedsAllocated = entry.itemExternalIds?.length === 1 || Boolean(entry.saleAllocatedProceedsCents)
    const gross = proceedsAllocated ? (entry.saleAllocatedProceedsCents?.[index] ?? allocateCents(entry.grossCents, quantities)[index] ?? 0) : entry.grossCents
    const fee = allocateCents(entry.feesCents, quantities)[index] ?? 0
    const shipping = allocateCents(entry.shippingCents ?? 0, quantities)[index] ?? 0
    const expense = allocateCents(entry.expensesCents, quantities)[index] ?? 0
    const received = allocateCents(entry.receivedCents, quantities)[index] ?? 0
    const paymentStatus: Sale['paymentStatus'] = entry.paymentStatus === 'confirmed' ? 'paid' : 'unpaid'
    return [{ sale: { id: entry.id, date: entry.date, platform: entry.platform ?? 'Other', grossCents: gross, feeCents: fee, shippingCents: shipping, otherExpenseCents: expense, paymentStatus, receivedCents: received, refundCents: 0, creditCents: 0, itemIds: [item.id], lines: [{ itemId: item.id, quantity, allocatedCostCents: entry.saleAllocatedCostCents?.[index] ?? 0, proceedsCents: entry.saleAllocatedProceedsCents?.[index] ?? 0, unitIds: entry.itemUnitIds?.[index] }], status: (entry.paymentStatus === 'confirmed' ? 'completed' : 'open') as Sale['status'], notes: entry.notes, fieldVerification: entry.fieldVerification }, grossCents: gross, quantity, proceedsAllocated }]
  })
  return [...recorded, ...migrated]
}

export function remainingAcquisitionCost(data: TrackerData, item: InventoryItem): number {
  const priorSales = data.sales.flatMap((sale) => sale.lines ?? []).filter((line) => line.itemId === item.id).reduce((sum, line) => sum + retainedCostCents(line), 0)
  const priorLedger = (data.ledgerTransactions ?? []).reduce((sum: number, entry: LedgerTransaction) => {
    const index = entry.itemExternalIds?.findIndex((id) => id === item.externalId) ?? -1
    return sum + (index >= 0 ? entry.saleAllocatedCostCents?.[index] ?? 0 : 0)
  }, 0)
  return Math.max(0, item.costCents - priorSales - priorLedger)
}

export function realizedLotProfitCents(data: TrackerData, lotId: string): number {
  const items = data.items.filter((item) => item.lotId === lotId)
  const itemIds = new Set(items.filter((item) => isFieldConfirmed(item, 'costCents')).map((item) => item.id))
  const externalIds = new Set(items.map((item) => item.externalId).filter((value): value is string => Boolean(value)))
  const recorded = data.sales.filter((sale) => sale.status === 'completed' && isFieldConfirmed(sale, 'receivedCents') && ['paid', 'partial', 'refunded'].includes(sale.paymentStatus)).reduce((sum, sale) => sum + (sale.lines ?? []).filter((line) => itemIds.has(line.itemId)).reduce((lineSum, line) => lineSum + lineNetProceedsCents(sale, line) - line.allocatedCostCents, 0), 0)
  const imported = (data.ledgerTransactions ?? []).filter((entry) => ['cash_sale', 'buyback_payout'].includes(entry.type) && entry.paymentStatus === 'confirmed' && isFieldConfirmed(entry, 'receivedCents') && (entry.lotId === lotId || (entry.itemExternalIds ?? []).some((id) => externalIds.has(id))) && Boolean(entry.saleAllocatedCostCents?.length) && entry.saleAllocatedProceedsCents?.length === entry.saleAllocatedCostCents?.length).reduce((sum, entry) => sum + (entry.saleAllocatedProceedsCents ?? []).reduce((total, value, index) => total + (entry.saleCostVerified?.[index] ? value : 0), 0) - (entry.saleAllocatedCostCents ?? []).reduce((total, value, index) => total + (entry.saleCostVerified?.[index] ? value : 0), 0), 0)
  return recorded + imported
}


