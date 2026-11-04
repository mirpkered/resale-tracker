export type ItemStatus = 'acquired' | 'draft' | 'active' | 'reserved' | 'awaiting_payment' | 'awaiting_fulfillment' | 'completed' | 'returned' | 'traded' | 'donated' | 'disposed'
export type PaymentStatus = 'unpaid' | 'partial' | 'paid' | 'refunded'
export type PlatformKind = 'sales' | 'trade_in' | 'rewards'

export interface PurchaseLot { id: string; name: string; date: string; source: string; purchaseCents: number; expensesCents: number; notes?: string }
export interface InventoryItem { id: string; title: string; description?: string; category: string; quantity: number; originalQuantity?: number; lotId: string | null; costCents: number; askingCents: number; suggestedAskingCents?: number; platform: string; status: ItemStatus; listedOn?: string; url?: string; image?: string; notes?: string; archived?: boolean }
export interface SaleLine { itemId: string; quantity: number; allocatedCostCents: number; proceedsCents?: number; returnedQuantity?: number }
export interface Sale { id: string; date: string; platform: string; grossCents: number; feeCents: number; shippingCents: number; otherExpenseCents: number; paymentStatus: PaymentStatus; receivedCents: number; refundCents: number; creditCents: number; itemIds: string[]; lines?: SaleLine[]; status: 'open' | 'completed' | 'returned' }
export interface CashExpense { id: string; date: string; amountCents: number; description: string }
export interface StoreCreditTransaction { id: string; date: string; kind: 'issued' | 'redeemed'; amountCents: number; description: string }
export interface Platform { id: string; name: string; kind: PlatformKind }
export interface TrackerData { lots: PurchaseLot[]; items: InventoryItem[]; sales: Sale[]; expenses: CashExpense[]; credit: StoreCreditTransaction[]; platforms: Platform[] }

export const STATUS_LABELS: Record<ItemStatus, string> = {
  acquired: 'Acquired / Unlisted', draft: 'Draft Listing', active: 'Active Listing', reserved: 'Reserved',
  awaiting_payment: 'Sold / Awaiting Payment', awaiting_fulfillment: 'Paid / Awaiting Fulfillment', completed: 'Completed',
  returned: 'Returned', traded: 'Traded', donated: 'Donated', disposed: 'Disposed',
}
export const ACTIVE_STATUSES: ItemStatus[] = ['acquired', 'draft', 'active', 'reserved', 'awaiting_payment', 'awaiting_fulfillment', 'returned']
export const PLATFORMS: Platform[] = [
  ...['Vinted', 'eBay', 'Amazon', 'World of Books', 'Local Sale', 'Other'].map((name) => ({ id: name.toLowerCase().replaceAll(' ', '-'), name, kind: 'sales' as const })),
  ...['GameStop', 'Vintage Stock', 'GameExchange', 'Play It Again Sports'].map((name) => ({ id: name.toLowerCase().replaceAll(' ', '-'), name, kind: 'trade_in' as const })),
  { id: 'staples', name: 'Staples rewards', kind: 'rewards' },
]

export const dollarsToCents = (value: string | number): number => {
  const text = String(value).trim()
  if (!/^\d+(\.\d{0,2})?$/.test(text)) throw new Error('Enter a non-negative amount with up to two decimal places.')
  const [whole, fraction = ''] = text.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}
export const formatMoney = (cents: number): string => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)

export function lotTotalCents(lot: PurchaseLot): number { return lot.purchaseCents + lot.expensesCents }
export function allocatedCostCents(data: TrackerData, lotId: string): number { return data.items.filter((item) => item.lotId === lotId).reduce((sum, item) => sum + item.costCents, 0) }
export function lotUnallocatedCents(data: TrackerData, lot: PurchaseLot): number { return lotTotalCents(lot) - allocatedCostCents(data, lot.id) }
export function saleNetCents(sale: Sale): number { return sale.grossCents - sale.feeCents - sale.shippingCents - sale.otherExpenseCents - sale.refundCents }
export function allocateCents(total: number, weights: number[]): number[] {
  if (!weights.length) return []
  const safeWeights = weights.map((weight) => Math.max(0, weight))
  const weightTotal = safeWeights.reduce((sum, value) => sum + value, 0)
  const normalized = weightTotal ? safeWeights : safeWeights.map(() => 1)
  const denominator = normalized.reduce((sum, value) => sum + value, 0)
  const raw = normalized.map((weight) => total * weight / denominator)
  const result = raw.map(Math.floor)
  let remainder = total - result.reduce((sum, value) => sum + value, 0)
  raw.map((value, index) => ({ index, fraction: value - Math.floor(value) })).sort((a, b) => b.fraction - a.fraction).forEach(({ index }) => { if (remainder-- > 0) result[index]++ })
  return result
}
export function lineNetProceedsCents(sale: Sale, line: SaleLine): number {
  const beforeRefund = sale.lines?.reduce((sum, itemLine) => sum + (itemLine.proceedsCents ?? 0), 0) ?? 0
  const refund = beforeRefund ? allocateCents(sale.refundCents, sale.lines!.map((itemLine) => itemLine.proceedsCents ?? 0))[sale.lines!.indexOf(line)] : 0
  return Math.max(0, (line.proceedsCents ?? 0) - refund)
}
export function retainedCostCents(line: SaleLine): number {
  const returned = line.returnedQuantity ?? 0
  const returnedCost = returned >= line.quantity ? line.allocatedCostCents : Math.floor(line.allocatedCostCents * returned / line.quantity)
  return line.allocatedCostCents - returnedCost
}
export function receivedCashCents(sale: Sale): number { return sale.paymentStatus === 'paid' || sale.paymentStatus === 'partial' || sale.paymentStatus === 'refunded' ? Math.max(0, sale.receivedCents - sale.refundCents) : 0 }
export function storeCreditBalanceCents(data: TrackerData): number { return data.credit.reduce((sum, entry) => sum + (entry.kind === 'issued' ? entry.amountCents : -entry.amountCents), 0) }

export function getMetrics(data: TrackerData) {
  const purchaseInvestmentCents = data.lots.reduce((sum, lot) => sum + lotTotalCents(lot), 0) + data.items.filter((item) => !item.lotId).reduce((sum, item) => sum + item.costCents, 0)
  const netCashProceedsCents = data.sales.reduce((sum, sale) => sum + receivedCashCents(sale), 0)
  const otherCashExpensesCents = data.expenses.reduce((sum, expense) => sum + expense.amountCents, 0)
  const overallCashPositionCents = netCashProceedsCents - purchaseInvestmentCents - otherCashExpensesCents
  const realizedItemProfitCents = data.sales.filter((sale) => sale.status === 'completed' && (sale.paymentStatus === 'paid' || sale.paymentStatus === 'refunded' || sale.paymentStatus === 'partial')).reduce((sum, sale) => {
    if (sale.lines?.length) return sum + sale.lines.reduce((lineSum, line) => lineSum + lineNetProceedsCents(sale, line) - retainedCostCents(line), 0)
    const cost = sale.itemIds.reduce((itemsSum, itemId) => itemsSum + (data.items.find((item) => item.id === itemId)?.costCents ?? 0), 0)
    return sum + saleNetCents(sale) - cost
  }, 0)
  const available = data.items.filter((item) => ACTIVE_STATUSES.includes(item.status))
  return {
    purchaseInvestmentCents, netCashProceedsCents, overallCashPositionCents, realizedItemProfitCents,
    remainingQuantity: available.reduce((sum, item) => sum + item.quantity, 0),
    remainingInventoryCostCents: available.reduce((sum, item) => sum + Math.max(0, item.costCents - data.sales.flatMap((sale) => sale.lines ?? []).filter((line) => line.itemId === item.id).reduce((cost, line) => cost + retainedCostCents(line), 0)), 0),
    unsoldAskingCents: available.reduce((sum, item) => sum + item.askingCents * item.quantity, 0),
    storeCreditBalanceCents: storeCreditBalanceCents(data),
  }
}

export function transitionStatus(current: ItemStatus, next: ItemStatus): ItemStatus {
  const allowed: Record<ItemStatus, ItemStatus[]> = {
    acquired: ['draft', 'active', 'traded', 'donated', 'disposed'], draft: ['acquired', 'active', 'reserved', 'traded', 'donated', 'disposed'],
    active: ['draft', 'reserved', 'awaiting_payment', 'traded', 'donated', 'disposed'], reserved: ['active', 'awaiting_payment', 'traded', 'donated', 'disposed'],
    awaiting_payment: ['active', 'awaiting_fulfillment', 'completed', 'returned'], awaiting_fulfillment: ['active', 'completed', 'returned'],
    completed: ['returned'], returned: ['active', 'draft', 'traded', 'donated', 'disposed'], traded: [], donated: [], disposed: [],
  }
  if (current !== next && !allowed[current].includes(next)) throw new Error(`Cannot change status from ${STATUS_LABELS[current]} to ${STATUS_LABELS[next]}.`)
  return next
}

export interface ImportRecord { sourceId: string; lotId?: string | null; itemId?: string; title: string; description?: string; category?: string; quantity?: number; acquisitionCost?: string | number; suggestedPrice?: string | number; confirmedPrice?: string | number; platform?: string; status?: ItemStatus; listingUrl?: string; imageUrl?: string; date?: string; notes?: string }
export interface ResaleImport { schemaVersion: '1.0'; source: string; records: ImportRecord[] }
export function parseImport(input: string): ResaleImport {
  const parsed: unknown = JSON.parse(input)
  if (!parsed || typeof parsed !== 'object' || !('schemaVersion' in parsed) || !('records' in parsed) || !('source' in parsed)) throw new Error('Import must include schemaVersion, source, and records.')
  const payload = parsed as ResaleImport
  if (payload.schemaVersion !== '1.0' || !Array.isArray(payload.records) || typeof payload.source !== 'string') throw new Error('Unsupported import format. Expected resale-tracker schema 1.0.')
  const seen = new Set<string>()
  for (const record of payload.records) {
    if (!record.sourceId || !record.title?.trim()) throw new Error('Each record requires sourceId and title.')
    if (seen.has(record.sourceId)) throw new Error(`Duplicate sourceId in this file: ${record.sourceId}`)
    seen.add(record.sourceId)
    if (record.quantity !== undefined && (!Number.isInteger(record.quantity) || record.quantity < 1)) throw new Error(`Invalid quantity for ${record.title}.`)
    if (record.acquisitionCost !== undefined) dollarsToCents(record.acquisitionCost)
    if (record.confirmedPrice !== undefined) dollarsToCents(record.confirmedPrice)
    if (record.suggestedPrice !== undefined) dollarsToCents(record.suggestedPrice)
    if (record.status !== undefined && !(record.status in STATUS_LABELS)) throw new Error(`Invalid listing status for ${record.title}.`)
  }
  return payload
}
function parseCsvRows(input:string):string[][] {
  const rows:string[][]=[];let row:string[]=[],field='',quoted=false
  for(let index=0;index<input.length;index++){
    const char=input[index]
    if(quoted){if(char==='"'&&input[index+1]==='"'){field+='"';index++}else if(char==='"')quoted=false;else field+=char}
    else if(char==='"')quoted=true
    else if(char===','){row.push(field);field=''}
    else if(char==='\n'){row.push(field);rows.push(row);row=[];field=''}
    else if(char!=='\r')field+=char
  }
  if(quoted)throw new Error('CSV contains an unmatched quote.')
  if(field.length||row.length){row.push(field);rows.push(row)}
  return rows.filter((entry)=>entry.some((value)=>value.trim().length>0))
}
export function parseImportText(input:string):ResaleImport {
  if(input.trimStart().startsWith('{'))return parseImport(input)
  const [header,...rows]=parseCsvRows(input)
  if(!header)throw new Error('CSV needs a header row.')
  const columns=header.map((value)=>value.trim())
  const position=(name:string)=>columns.indexOf(name)
  for(const required of ['source','sourceId','title'])if(position(required)<0)throw new Error(`CSV is missing the ${required} column.`)
  const sourceAt=position('source'),source=rows.length?rows[0][sourceAt]?.trim():'manual-csv'
  const records=rows.map((row)=>{const value=(name:string)=>{const column=position(name);return column<0?undefined:row[column]?.trim()};const record:Record<string,unknown>={sourceId:value('sourceId'),title:value('title')};for(const name of ['lotId','description','category','quantity','acquisitionCost','suggestedPrice','confirmedPrice','platform','status','listingUrl','imageUrl','date','notes']){const cell=value(name);if(cell!==undefined&&cell!=='')record[name]=name==='quantity'?Number(cell):cell}if(sourceAt>=0&&value('source')!==source)throw new Error('All CSV rows must use the same source value.');return record as unknown as ImportRecord})
  return parseImport(JSON.stringify({schemaVersion:'1.0',source:source||'manual-csv',records}))
}
export function importPreview(data: TrackerData, payload: ResaleImport) {
  return payload.records.map((record) => {
    const existing = data.items.find((item) => item.id === record.itemId || item.notes?.includes(`[source:${payload.source}:${record.sourceId}]`))
    return { record, existing, action: existing ? 'update' as const : 'create' as const }
  })
}
