export type AppRoute = { section: 'Dashboard' | 'Lots' | 'Settings'; lotId?: string }

export function parseAppRoute(hash: string): AppRoute {
  const value = hash.replace(/^#/, '')
  if (value.startsWith('lot/')) {
    try { return { section: 'Lots', lotId: decodeURIComponent(value.slice(4)) } }
    catch { return { section: 'Lots' } }
  }
  if (value === 'lots') return { section: 'Lots' }
  if (value === 'settings') return { section: 'Settings' }
  return { section: 'Dashboard' }
}

export function routeHash(route: AppRoute): string {
  return route.section === 'Lots' && route.lotId ? `#lot/${encodeURIComponent(route.lotId)}` : `#${route.section.toLowerCase()}`
}
