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
})
