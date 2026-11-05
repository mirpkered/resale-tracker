import type { InventoryItem, ItemStatus, TrackerData } from './domain'

export interface InventoryFilters {
  lotId: string
  platform: string
  category: string
  status: string
}

export type InventorySort = 'title' | 'cost_desc' | 'cost_asc' | 'asking_desc' | 'asking_asc' | 'quantity_desc'

export const emptyInventoryFilters: InventoryFilters = { lotId: 'all', platform: 'all', category: 'all', status: 'all' }

export function filterInventoryItems(data: TrackerData, query: string, filters: InventoryFilters): InventoryItem[] {
  const search = query.trim().toLocaleLowerCase()
  const lots = new Map(data.lots.map((lot) => [lot.id, lot.name]))
  return data.items.filter((item) => {
    if (item.archived) return false
    if (filters.lotId !== 'all' && (item.lotId ?? 'standalone') !== filters.lotId) return false
    if (filters.platform !== 'all' && item.platform !== filters.platform) return false
    if (filters.category !== 'all' && item.category !== filters.category) return false
    if (filters.status !== 'all' && item.status !== filters.status) return false
    if (!search) return true
    const searchable = [item.title, item.description, item.category, item.platform, item.status, item.lotId ? lots.get(item.lotId) : 'Standalone']
      .filter(Boolean).join(' ').toLocaleLowerCase()
    return searchable.includes(search)
  })
}

export function sortInventoryItems(items: InventoryItem[], sort: InventorySort): InventoryItem[] {
  return [...items].sort((a, b) => {
    if (sort === 'cost_desc') return b.costCents - a.costCents || a.title.localeCompare(b.title)
    if (sort === 'cost_asc') return a.costCents - b.costCents || a.title.localeCompare(b.title)
    if (sort === 'asking_desc') return b.askingCents - a.askingCents || a.title.localeCompare(b.title)
    if (sort === 'asking_asc') return a.askingCents - b.askingCents || a.title.localeCompare(b.title)
    if (sort === 'quantity_desc') return b.quantity - a.quantity || a.title.localeCompare(b.title)
    return a.title.localeCompare(b.title)
  })
}

export const inventoryStatuses: ItemStatus[] = ['acquired', 'draft', 'active', 'reserved', 'awaiting_payment', 'awaiting_fulfillment', 'completed', 'returned', 'traded', 'donated', 'disposed']
