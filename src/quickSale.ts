import { ACTIVE_STATUSES, allocateCents, type InventoryUnit, type Sale, type TrackerData } from './domain'
import { remainingAcquisitionCost } from './lotView'

export interface QuickSaleInput {
  date: string
  platform: string
  grossCents: number
  feeCents: number
  shippingCents: number
  otherExpenseCents: number
  quantity?: number
  /** Voice-confirmed marketplace sales default to unpaid unless receipt is explicitly confirmed. */
  paymentReceived?: boolean
  externalSource?: string
  externalId?: string
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

export function recordQuickSale(data: TrackerData, itemId: string, input: QuickSaleInput, idFactory: () => string = () => crypto.randomUUID()): { data: TrackerData; sale: Sale; unit: InventoryUnit; duplicate: boolean } {
  if (input.externalSource && input.externalId) {
    const existing = data.sales.find((sale) => sale.externalSource === input.externalSource && sale.externalId === input.externalId)
    if (existing) {
      const unitId = existing.lines?.[0]?.unitIds?.[0]
      const unit = data.units?.find((entry) => entry.id === unitId) ?? { id: unitId ?? existing.id, itemId, copyNumber: 1, status: 'completed' as const }
      return { data, sale: existing, unit, duplicate: true }
    }
  }
  const item = data.items.find((entry) => entry.id === itemId)
  if (!item) throw new Error('This inventory item could not be found.')
  if (!ACTIVE_STATUSES.includes(item.status) || item.quantity < 1) throw new Error('This item has no available inventory unit to sell.')
  const quantity = input.quantity ?? 1
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > item.quantity) throw new Error('Sale quantity exceeds the available inventory units.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !input.platform.trim()) throw new Error('Enter a valid sale date and platform.')
  for (const [label, cents] of Object.entries({ 'sale amount': input.grossCents, fees: input.feeCents, shipping: input.shippingCents, expenses: input.otherExpenseCents })) {
    if (!Number.isSafeInteger(cents) || cents < 0) throw new Error(`Enter a valid nonnegative ${label}.`)
  }
  const netCents = input.grossCents - input.feeCents - input.shippingCents - input.otherExpenseCents
  if (netCents < 0) throw new Error('Fees, shipping, and expenses cannot exceed the sale amount.')

  const allUnits = [...(data.units ?? [])]
  const itemUnits = allUnits.filter((unit) => unit.itemId === itemId)
  const alreadySoldUnitIds = new Set(data.sales.flatMap((sale) => (sale.lines ?? []).flatMap((line) => (line.unitIds ?? []).slice(line.returnedQuantity ?? 0))))
  const availableUnits = itemUnits.filter((entry) => ACTIVE_STATUSES.includes(entry.status) && !alreadySoldUnitIds.has(entry.id))
  while (availableUnits.length < quantity) {
    const created: InventoryUnit = { id: idFactory(), itemId, copyNumber: Math.max(0, ...itemUnits.map((entry) => entry.copyNumber), ...availableUnits.map((entry) => entry.copyNumber)) + 1, status: item.status }
    allUnits.push(created); itemUnits.push(created); availableUnits.push(created)
  }
  const selectedUnits = availableUnits.slice(0, quantity).map((unit) => ({ ...unit, status: 'completed' as const }))
  const unit = selectedUnits[0]
  const remainingCost = remainingAcquisitionCost(data, item)
  const allocatedCostCents = quantity === item.quantity ? remainingCost : Math.floor(remainingCost * quantity / item.quantity)
  const paymentReceived = input.paymentReceived ?? true
  const sale: Sale = {
    id: idFactory(), date: input.date, platform: input.platform.trim(), grossCents: input.grossCents,
    feeCents: input.feeCents, shippingCents: input.shippingCents, otherExpenseCents: input.otherExpenseCents,
    paymentStatus: paymentReceived ? 'paid' : 'unpaid', receivedCents: paymentReceived ? netCents : 0, refundCents: 0, creditCents: 0,
    itemIds: [itemId], lines: [{ itemId, quantity, allocatedCostCents, proceedsCents: netCents, unitIds: selectedUnits.map((entry) => entry.id) }], status: paymentReceived ? 'completed' : 'open',
    externalSource: input.externalSource, externalId: input.externalId,
    fieldVerification: { date: 'confirmed', platform: 'confirmed', grossCents: 'confirmed', feeCents: 'confirmed', shippingCents: 'confirmed', otherExpenseCents: 'confirmed', receivedCents: paymentReceived ? 'confirmed' : 'pending', paymentStatus: 'confirmed' },
  }
  const remaining = item.quantity - quantity
  const updatedItem = { ...item, quantity: remaining, status: (remaining === 0 ? 'completed' : item.status) as typeof item.status }
  const platformExists = data.platforms.some((entry) => entry.name.toLowerCase() === sale.platform.toLowerCase())
  const platform = platformExists ? data.platforms : [...data.platforms, { id: sale.platform.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-'), name: sale.platform, kind: 'sales' as const }]
  return {
    data: { ...data, units: allUnits.map((entry) => selectedUnits.find((selected) => selected.id === entry.id) ?? entry), items: data.items.map((entry) => entry.id === itemId ? updatedItem : entry), sales: [sale, ...data.sales], platforms: platform },
    sale,
    unit,
    duplicate: false,
  }
}
export interface BundleSaleSelection { itemId: string; quantity: number }

/** Records one marketplace transaction with one sale line per selected inventory record. */
export function recordBundleSale(data: TrackerData, selections: BundleSaleSelection[], input: QuickSaleInput, idFactory: () => string = () => crypto.randomUUID()): { data: TrackerData; sale: Sale; duplicate: boolean } {
  if (input.externalSource && input.externalId) {
    const existing = data.sales.find((sale) => sale.externalSource === input.externalSource && sale.externalId === input.externalId)
    if (existing) return { data, sale: existing, duplicate: true }
  }
  if (!selections.length) throw new Error('Select at least one available inventory item for this bundle.')
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(input.date) || !input.platform.trim()) throw new Error('Enter a valid sale date and confirm the marketplace platform.')
  for (const [label, cents] of Object.entries({ 'sale amount': input.grossCents, fees: input.feeCents, shipping: input.shippingCents, expenses: input.otherExpenseCents })) {
    if (!Number.isSafeInteger(cents) || cents < 0) throw new Error(`Enter a valid nonnegative ${label}.`)
  }
  const netCents = input.grossCents - input.feeCents - input.shippingCents - input.otherExpenseCents
  if (netCents < 0) throw new Error('Fees, shipping, and expenses cannot exceed the bundle sale amount.')
  const combined = new Map<string, number>()
  for (const selection of selections) {
    if (!Number.isSafeInteger(selection.quantity) || selection.quantity < 1) throw new Error('Each selected item needs a positive whole-number quantity.')
    combined.set(selection.itemId, (combined.get(selection.itemId) ?? 0) + selection.quantity)
  }
  const selectedItems = [...combined].map(([itemId, quantity]) => {
    const item = data.items.find((entry) => entry.id === itemId)
    if (!item) throw new Error('A selected inventory item could not be found.')
    if (item.archived || !ACTIVE_STATUSES.includes(item.status) || item.quantity < quantity) throw new Error(`${item.title} no longer has the selected quantity available.`)
    return { item, quantity }
  })
  const existingUnits = [...(data.units ?? [])]
  const activeSaleUnitIds = new Set(data.sales.flatMap((sale) => (sale.lines ?? []).flatMap((line) => (line.unitIds ?? []).slice(line.returnedQuantity ?? 0))))
  const selectedUnitsByItem = new Map<string, InventoryUnit[]>()
  for (const { item, quantity } of selectedItems) {
    let itemUnits = existingUnits.filter((unit) => unit.itemId === item.id)
    if (!itemUnits.length) {
      itemUnits = Array.from({ length: item.quantity }, (_, index) => ({ id: idFactory(), itemId: item.id, copyNumber: index + 1, status: item.status }))
      existingUnits.push(...itemUnits)
    }
    const available = itemUnits.filter((unit) => ACTIVE_STATUSES.includes(unit.status) && !activeSaleUnitIds.has(unit.id))
    if (available.length < quantity) throw new Error(`${item.title} has fewer available physical units than the inventory quantity indicates. Reconcile its units before selling.`)
    selectedUnitsByItem.set(item.id, available.slice(0, quantity))
  }
  const lines = selectedItems.map(({ item, quantity }) => {
    const remainingCost = remainingAcquisitionCost(data, item)
    const allocatedCostCents = quantity === item.quantity ? remainingCost : Math.floor(remainingCost * quantity / Math.max(item.quantity, 1))
    return { itemId: item.id, quantity, allocatedCostCents, ...(selectedItems.length === 1 ? { proceedsCents: netCents } : {}), unitIds: selectedUnitsByItem.get(item.id)!.map((unit) => unit.id) }
  })
  const paymentReceived = input.paymentReceived ?? false
  const sale: Sale = {
    id: idFactory(), date: input.date, platform: input.platform.trim(), grossCents: input.grossCents,
    feeCents: input.feeCents, shippingCents: input.shippingCents, otherExpenseCents: input.otherExpenseCents,
    paymentStatus: paymentReceived ? 'paid' : 'unpaid', receivedCents: paymentReceived ? netCents : 0, refundCents: 0, creditCents: 0,
    itemIds: selectedItems.map(({ item }) => item.id), lines,
    status: paymentReceived ? 'completed' : 'open',
    notes: selectedItems.length > 1 ? 'Bundle sale recorded as one transaction. Total proceeds and shared expenses are recorded once; individual item proceeds are unallocated pending verified per-item allocation.' : undefined,
    externalSource: input.externalSource, externalId: input.externalId,
    fieldVerification: { date: 'confirmed', platform: 'confirmed', grossCents: 'confirmed', feeCents: 'confirmed', shippingCents: 'confirmed', otherExpenseCents: 'confirmed', receivedCents: paymentReceived ? 'confirmed' : 'pending', paymentStatus: 'confirmed', lineProceedsAllocation: selectedItems.length > 1 ? 'unknown' : 'confirmed' },
  }
  const chosenUnitIds = new Set(lines.flatMap((line) => line.unitIds ?? []))
  const units = existingUnits.map((unit) => chosenUnitIds.has(unit.id) ? { ...unit, status: paymentReceived ? 'completed' as const : 'awaiting_payment' as const } : unit)
  const nextItems = data.items.map((item) => {
    const selection = selectedItems.find((entry) => entry.item.id === item.id)
    if (!selection) return item
    const quantity = item.quantity - selection.quantity
    return { ...item, quantity, status: (quantity === 0 ? paymentReceived ? 'completed' : 'awaiting_payment' : item.status) as typeof item.status }
  })
  const platforms = data.platforms.some((platform) => platform.name.toLowerCase() === sale.platform.toLowerCase()) ? data.platforms : [...data.platforms, { id: sale.platform.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-'), name: sale.platform, kind: 'sales' as const }]
  return { data: { ...data, units, items: nextItems, sales: [sale, ...data.sales], platforms }, sale, duplicate: false }
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
  const unallocatedBundle = (original.lines?.length ?? 0) > 1 && original.lines!.some((line) => line.proceedsCents === undefined)
  const proceeds = allocateCents(netCents, (original.lines ?? []).map((line) => line.proceedsCents ?? line.quantity))
  const lines = original.lines?.map((line, index) => unallocatedBundle ? { ...line, proceedsCents: undefined } : { ...line, proceedsCents: proceeds[index] })
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
