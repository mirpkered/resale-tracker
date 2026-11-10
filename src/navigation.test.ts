import { describe, expect, it } from 'vitest'
import { parseAppRoute, routeHash } from './navigation'

describe('stable lot navigation routes',()=>{
  it('creates and parses an exact lot-id route for history and refresh',()=>{
    const hash=routeHash({section:'Lots',lotId:'goodwill-uuid/with space'})
    expect(hash).toBe('#lot/goodwill-uuid%2Fwith%20space')
    expect(parseAppRoute(hash)).toEqual({section:'Lots',lotId:'goodwill-uuid/with space'})
  })
  it('falls back safely for malformed or general section routes',()=>{
    expect(parseAppRoute('#lot/%E0%A4%A')).toEqual({section:'Lots'})
    expect(parseAppRoute('#lots')).toEqual({section:'Lots'})
    expect(parseAppRoute('')).toEqual({section:'Dashboard'})
  })
  it('preserves a selected global-listing item route for refresh and history',()=>{
    const hash=routeHash({section:'Listings',itemId:'item / one'})
    expect(hash).toBe('#listings/item/item%20%2F%20one')
    expect(parseAppRoute(hash)).toEqual({section:'Listings',itemId:'item / one'})
    expect(parseAppRoute('#listings')).toEqual({section:'Listings'})
  })
})
