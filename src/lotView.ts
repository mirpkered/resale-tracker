import { ACTIVE_STATUSES, allocateCents, isFieldConfirmed, lineNetProceedsCents, receivedCashCents, retainedCostCents, type InventoryItem, type LedgerTransaction, type PurchaseLot, type Sale, type TrackerData } from './domain'

export const PRIMARY_NAVIGATION = ['Dashboard', 'Lots', 'Settings'] as const

export interface LotSummary {
  lot: PurchaseLot
  purchased: number
  sold: number
  remaining: number
  grossConfirmedSalesCents: number
  cashReceivedCents: number
  cashPositionCents: number
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

function ledgerLotAmounts(data: TrackerData, externalIds: Set<string>) {
  let grossCents = 0, cashCents = 0, sold = 0
  for (const entry of data.ledgerTransactions ?? []) {
    if (!['cash_sale', 'buyback_payout'].includes(entry.type)) continue
    const matchingIndexes = (entry.itemExternalIds ?? []).map((id, index) => externalIds.has(id) ? index : -1).filter((index) => index >= 0)
    if (!matchingIndexes.length) continue
    const quantityWeights = entry.itemQuantities ?? matchingIndexes.map(() => 1)
    const grossShares = allocateCents(entry.grossCents, quantityWeights)
    if (entry.paymentStatus === 'confirmed') grossCents += matchingIndexes.reduce((sum, index) => sum + (grossShares[index] ?? 0), 0)
    if (entry.paymentStatus === 'confirmed' && isFieldConfirmed(entry, 'receivedCents')) {
      cashCents += matchingIndexes.reduce((sum, index) => sum + (allocateCents(entry.receivedCents, quantityWeights)[index] ?? 0), 0)
    }
    sold += matchingIndexes.reduce((sum, index) => sum + (entry.itemQuantities?.[index] ?? 0), 0)
  }
  return { grossCents, cashCents, sold }
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
  const ledger = ledgerLotAmounts(data, externalIds)
  sold += ledger.sold
  grossConfirmedSalesCents += ledger.grossCents
  cashReceivedCents += ledger.cashCents
  const cost = (isFieldConfirmed(lot, 'purchaseCents') ? lot.purchaseCents : 0) + (isFieldConfirmed(lot, 'expensesCents') ? lot.expensesCents : 0)
  return { lot, purchased, sold, remaining, grossConfirmedSalesCents, cashReceivedCents, cashPositionCents: cashReceivedCents - cost, itemCount: items.length }
}

export function itemSales(data: TrackerData, item: InventoryItem) {
  return data.sales.flatMap((sale) => {
    const lines = sale.lines ?? []
    const lineIndexes = lines.map((line, index) => line.itemId === item.id ? index : -1).filter((index) => index >= 0)
    const gross = lineIndexes.reduce((sum, index) => sum + grossForLine(sale, index), 0)
    if (gross || sale.itemIds.includes(item.id)) return [{ sale, grossCents: lines.length ? gross : saleGrossForItem(sale, item.id), quantity: lines.filter((line) => line.itemId === item.id).reduce((sum, line) => sum + line.quantity, 0) || 1 }]
    return []
  })
}

export function remainingAcquisitionCost(data: TrackerData, item: InventoryItem): number {
  const priorSales = data.sales.flatMap((sale) => sale.lines ?? []).filter((line) => line.itemId === item.id).reduce((sum, line) => sum + retainedCostCents(line), 0)
  const priorLedger = (data.ledgerTransactions ?? []).reduce((sum: number, entry: LedgerTransaction) => {
    const index = entry.itemExternalIds?.findIndex((id) => id === item.externalId) ?? -1
    return sum + (index >= 0 ? entry.saleAllocatedCostCents?.[index] ?? 0 : 0)
  }, 0)
  return Math.max(0, item.costCents - priorSales - priorLedger)
}


