import { ACTIVE_STATUSES, type InventoryItem, type TrackerData } from './domain'

export interface LifecycleDecision {
  allowed: boolean
  reasons: string[]
}

export function visibleInventoryItems<T extends InventoryItem>(items: T[], showArchived: boolean): T[] {
  return items.filter((item) => showArchived || !item.archived)
}

export function archiveEligibility(item: InventoryItem): LifecycleDecision {
  const reasons: string[] = []
  if (item.status === 'active') reasons.push('This item has an active listing. End or resolve that listing first.')
  if (item.quantity > 0 && ACTIVE_STATUSES.includes(item.status)) reasons.push(`${item.quantity} available unit${item.quantity === 1 ? '' : 's'} remain. Sell, dispose of, or otherwise resolve them first.`)
  return { allowed: reasons.length === 0, reasons }
}

/**
 * Deletion is intentionally limited to empty, zero-cost records with no stable
 * imported identity, listing link, inventory-unit history, or financial links.
 * Anything else can be archived without disturbing its accounting history.
 */
export function deletionEligibility(data: TrackerData, itemId: string): LifecycleDecision {
  const item = data.items.find((entry) => entry.id === itemId)
  if (!item) return { allowed: false, reasons: ['The item no longer exists. Refresh before trying again.'] }
  const reasons: string[] = []
  if (item.quantity !== 0) reasons.push('The item still has a quantity. Resolve or archive its inventory first.')
  if ((item.originalQuantity ?? 0) !== 0) reasons.push('The item has an original acquired quantity recorded.')
  if (item.costCents !== 0) reasons.push('The item has allocated acquisition cost.')
  if (item.status === 'active' || Boolean(item.url?.trim())) reasons.push('The item has an active or linked listing.')
  if (item.externalSource || item.externalId) reasons.push('The item has a stable import identity; archive it to prevent re-import duplication.')
  if ((data.units ?? []).some((unit) => unit.itemId === item.id)) reasons.push('Individual inventory units reference this item.')
  if (data.sales.some((sale) => sale.itemIds.includes(item.id) || sale.lines?.some((line) => line.itemId === item.id))) reasons.push('Sale or bundle history references this item.')
  const unitIds = new Set((data.units ?? []).filter((unit) => unit.itemId === item.id).map((unit) => unit.id))
  if (item.externalId && (data.ledgerTransactions ?? []).some((entry) => entry.itemExternalIds?.includes(item.externalId!) || entry.itemUnitIds?.some((ids) => ids.some((id) => unitIds.has(id))))) reasons.push('A payout, buyback, or other ledger record references this item.')
  return { allowed: reasons.length === 0, reasons }
}

export function archiveInventoryItem(data: TrackerData, itemId: string): TrackerData {
  const item = data.items.find((entry) => entry.id === itemId)
  if (!item) throw new Error('This inventory item no longer exists.')
  const eligibility = archiveEligibility(item)
  if (!eligibility.allowed) throw new Error(eligibility.reasons.join(' '))
  return { ...data, items: data.items.map((entry) => entry.id === itemId ? { ...entry, archived: true } : entry) }
}

export function restoreInventoryItem(data: TrackerData, itemId: string): TrackerData {
  if (!data.items.some((entry) => entry.id === itemId)) throw new Error('This archived item no longer exists.')
  return { ...data, items: data.items.map((entry) => entry.id === itemId ? { ...entry, archived: false } : entry) }
}

export function deleteInventoryItem(data: TrackerData, itemId: string): TrackerData {
  const eligibility = deletionEligibility(data, itemId)
  if (!eligibility.allowed) throw new Error(eligibility.reasons.join(' '))
  return { ...data, items: data.items.filter((item) => item.id !== itemId) }
}
