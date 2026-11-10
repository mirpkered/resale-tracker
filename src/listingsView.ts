import { ACTIVE_STATUSES, isFieldConfirmed, type InventoryItem, type TrackerData } from './domain'
import { itemSales, sortLotInventoryItems, inventoryStatusGroup, type InventoryStatusGroup } from './lotView'
import { visibleInventoryItems } from './itemLifecycle'

export type ListingsFilter = InventoryStatusGroup | 'all'
export interface ListingsQuery { search?: string; status?: ListingsFilter; platform?: string; lotId?: string; showArchived?: boolean }

/** Global listing rows are derived from canonical inventory; no records are created or reordered. */
export function selectGlobalListings(data: TrackerData, query: ListingsQuery = {}): InventoryItem[] {
  const needle = (query.search ?? '').trim().toLocaleLowerCase()
  const status = query.status ?? 'listed'
  const items = visibleInventoryItems(data.items, Boolean(query.showArchived)).filter((item) => {
    const group = inventoryStatusGroup(item)
    if (status !== 'all' && group !== status) return false
    if (query.platform && item.platform.toLocaleLowerCase() !== query.platform.toLocaleLowerCase()) return false
    if (query.lotId && (query.lotId === '__standalone__' ? Boolean(item.lotId) : item.lotId !== query.lotId)) return false
    if (!needle) return true
    const lotName = data.lots.find((lot) => lot.id === item.lotId)?.name ?? 'standalone'
    return [item.title, item.description, item.category, item.platform, item.id, item.externalId, item.notes, lotName].some((field) => field?.toLocaleLowerCase().includes(needle))
  })
  return sortLotInventoryItems(items)
}

export function listingGroupLabel(item: InventoryItem): string {
  const labels: Record<InventoryStatusGroup, string> = { listed: 'Listed', unlisted: 'Unlisted', sold: 'Sold', disposed: 'Disposed' }
  return labels[inventoryStatusGroup(item)]
}

export function listingPriceLabel(data: TrackerData, item: InventoryItem): { label: string; cents?: number } {
  const group = inventoryStatusGroup(item)
  if (group === 'listed' && item.askingCents > 0 && isFieldConfirmed(item, 'askingCents')) return { label: 'Active asking', cents: item.askingCents }
  if (group === 'sold') {
    const sales = itemSales(data, item)
    const allocated = sales.filter((sale) => sale.proceedsAllocated)
    return allocated.length ? { label: 'Actual sale price', cents: allocated.reduce((sum, sale) => sum + sale.grossCents, 0) } : { label: 'Sale recorded · item share unknown' }
  }
  return { label: group === 'listed' ? 'Active listing · price unconfirmed' : 'No active asking price' }
}

export function globalListingCounts(data: TrackerData) {
  const groups: Record<InventoryStatusGroup, number> = { listed: 0, unlisted: 0, sold: 0, disposed: 0 }
  for (const item of data.items) groups[inventoryStatusGroup(item)] += 1
  return { ...groups, availableCopies: data.items.filter((item) => ACTIVE_STATUSES.includes(item.status)).reduce((sum, item) => sum + item.quantity, 0) }
}
