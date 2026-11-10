export type AppRoute = { section: 'Dashboard' | 'Lots' | 'Listings' | 'Settings'; lotId?: string; itemId?: string }

export function parseAppRoute(hash: string): AppRoute {
  const value = hash.replace(/^#/, '')
  if (value.startsWith('lot/')) {
    try { return { section: 'Lots', lotId: decodeURIComponent(value.slice(4)) } }
    catch { return { section: 'Lots' } }
  }
  if (value.startsWith('listings/item/')) {
    try { return { section: 'Listings', itemId: decodeURIComponent(value.slice('listings/item/'.length)) } }
    catch { return { section: 'Listings' } }
  }
  if (value === 'listings') return { section: 'Listings' }
  if (value === 'lots') return { section: 'Lots' }
  if (value === 'settings') return { section: 'Settings' }
  return { section: 'Dashboard' }
}

export function routeHash(route: AppRoute): string {
  if (route.section === 'Listings' && route.itemId) return `#listings/item/${encodeURIComponent(route.itemId)}`
  return route.section === 'Lots' && route.lotId ? `#lot/${encodeURIComponent(route.lotId)}` : `#${route.section.toLowerCase()}`
}
