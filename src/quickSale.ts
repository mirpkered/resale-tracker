import { ACTIVE_STATUSES, allocateCents, type InventoryUnit, type Sale, type TrackerData } from './domain'
import { remainingAcquisitionCost } from './lotView'

export interface QuickSaleInput {
  date: string
  platform: string
  grossCents: number
  feeCents: number
  shippingCents: number
  otherExpenseCents: number
}

export interface SaleCorrection {
  date: string
  platform: string
  grossCents: number
  feeCents: number
  shippingCents: number
  otherExpenseCents: number
  paid: boolean
}

export function quickSalePriceDefault(askingCents: number): string {
  return askingCents > 0 && Number.isSafeInteger(askingCents) ? (askingCents / 100).toFixed(2) : ''
}

export function recordQuickSale(data: TrackerData, itemId: string, input: QuickSaleInput, idFactory: () => string = () => crypto.randomUUID()): { data: TrackerData; sale: Sale; unit: InventoryUnit } {
  const item = data.items.find((entry) => entry.id === itemId)
  if (!item) throw new Error('This inventory item could not be found.')
  if (!ACTIVE_STATUSES.includes(item.status) || item.quantity < 1) throw new Error('This item has no available inventory unit to sell.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !input.platform.trim()) throw new Error('Enter a valid sale date and platform.')
  for (const [label, cents] of Object.entries({ 'sale amount': input.grossCents, fees: input.feeCents, shipping: input.shippingCents, expenses: input.otherExpenseCents })) {
    if (!Number.isSafeInteger(cents) || cents < 0) throw new Error(`Enter a valid nonnegative ${label}.`)
  }
  const netCents = input.grossCents - input.feeCents - input.shippingCents - input.otherExpenseCents
  if (netCents < 0) throw new Error('Fees, shipping, and expenses cannot exceed the sale amount.')

  const allUnits = [...(data.units ?? [])]
  const itemUnits = allUnits.filter((unit) => unit.itemId === itemId)
  const alreadySoldUnitIds = new Set(data.sales.flatMap((sale) => (sale.lines ?? []).flatMap((line) => (line.unitIds ?? []).slice(line.returnedQuantity ?? 0))))
  let unit = itemUnits.find((entry) => ACTIVE_STATUSES.includes(entry.status) && !alreadySoldUnitIds.has(entry.id))
  if (!unit) {
    unit = { id: idFactory(), itemId, copyNumber: Math.max(0, ...itemUnits.map((entry) => entry.copyNumber)) + 1, status: item.status }
    allUnits.push(unit)
  }
  const remainingCost = remainingAcquisitionCost(data, item)
  const allocatedCostCents = item.quantity === 1 ? remainingCost : Math.floor(remainingCost / item.quantity)
  const sale: Sale = {
    id: idFactory(), date: input.date, platform: input.platform.trim(), grossCents: input.grossCents,
    feeCents: input.feeCents, shippingCents: input.shippingCents, otherExpenseCents: input.otherExpenseCents,
    paymentStatus: 'paid', receivedCents: netCents, refundCents: 0, creditCents: 0,
    itemIds: [itemId], lines: [{ itemId, quantity: 1, allocatedCostCents, proceedsCents: netCents, unitIds: [unit.id] }], status: 'completed',
    fieldVerification: { date: 'confirmed', platform: 'confirmed', grossCents: 'confirmed', feeCents: 'confirmed', shippingCents: 'confirmed', otherExpenseCents: 'confirmed', receivedCents: 'confirmed', paymentStatus: 'confirmed' },
  }
  unit = { ...unit, status: 'completed' }
  const remaining = item.quantity - 1
  const updatedItem = { ...item, quantity: remaining, status: (remaining === 0 ? 'completed' : item.status) as typeof item.status }
  const platformExists = data.platforms.some((entry) => entry.name.toLowerCase() === sale.platform.toLowerCase())
  const platform = platformExists ? data.platforms : [...data.platforms, { id: sale.platform.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-'), name: sale.platform, kind: 'sales' as const }]
  return {
    data: { ...data, units: allUnits.map((entry) => entry.id === unit.id ? unit! : entry), items: data.items.map((entry) => entry.id === itemId ? updatedItem : entry), sales: [sale, ...data.sales], platforms: platform },
    sale,
    unit,
  }
}

export function correctExistingSale(data: TrackerData, saleId: string, correction: SaleCorrection): TrackerData {
  const original = data.sales.find((sale) => sale.id === saleId)
  if (!original) throw new Error('The sale record could not be found.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(correction.date) || !correction.platform.trim()) throw new Error('Enter a valid sale date and platform.')
  for (const [label, cents] of Object.entries({ 'sale amount': correction.grossCents, fees: correction.feeCents, shipping: correction.shippingCents, expenses: correction.otherExpenseCents })) {
    if (!Number.isSafeInteger(cents) || cents < 0) throw new Error(`Enter a valid nonnegative ${label}.`)
  }
  const netCents = correction.grossCents - correction.feeCents - correction.shippingCents - correction.otherExpenseCents
  if (netCents < original.refundCents) throw new Error('The revised net cannot be lower than its recorded refund; update the return first.')
  const proceeds = allocateCents(netCents, (original.lines ?? []).map((line) => line.proceedsCents ?? line.quantity))
  const lines = original.lines?.map((line, index) => ({ ...line, proceedsCents: proceeds[index] }))
  const updated: Sale = {
    ...original, date: correction.date, platform: correction.platform.trim(), grossCents: correction.grossCents,
    feeCents: correction.feeCents, shippingCents: correction.shippingCents, otherExpenseCents: correction.otherExpenseCents,
    paymentStatus: correction.paid ? 'paid' : 'unpaid', receivedCents: correction.paid ? netCents : 0, lines,
    fieldVerification: { ...original.fieldVerification, date: 'confirmed', platform: 'confirmed', grossCents: 'confirmed', feeCents: 'confirmed', shippingCents: 'confirmed', otherExpenseCents: 'confirmed', receivedCents: correction.paid ? 'confirmed' : 'pending', paymentStatus: 'confirmed' },
  }
  const unitIds = new Set((updated.lines ?? []).flatMap((line) => line.unitIds ?? []))
  const platforms = data.platforms.some((platform) => platform.name.toLowerCase() === updated.platform.toLowerCase())
    ? data.platforms
    : [...data.platforms, { id: updated.platform.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-'), name: updated.platform, kind: 'sales' as const }]
  return {
    ...data,
    platforms,
    units: (data.units ?? []).map((unit) => unitIds.has(unit.id) ? { ...unit, status: correction.paid ? 'completed' as const : 'awaiting_payment' as const } : unit),
    items: data.items.map((item) => updated.itemIds.includes(item.id) && item.quantity === 0 ? { ...item, status: correction.paid ? 'completed' : 'awaiting_payment' } : item),
    sales: data.sales.map((sale) => sale.id === saleId ? updated : sale),
  }
}
