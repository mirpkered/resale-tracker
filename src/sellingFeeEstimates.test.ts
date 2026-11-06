import { describe, expect, it } from 'vitest'
import { defaultSellerShippingCents, estimateSellingFee } from './sellingFeeEstimates'

describe('resale platform sale-fee defaults and estimates', () => {
  it.each(['Vinted','World of Books','Vintage Stock','Other','Local Sale','Other / Local'])('%s defaults to zero and remains an editable estimate', platform => {
    expect(estimateSellingFee(platform, 350, 1).cents).toBe(0)
    expect(defaultSellerShippingCents(platform)).toBe(0)
  })
  it('estimates eBay category and order fees, independent of editable shipping', () => {
    expect(estimateSellingFee('eBay', 1000, 1, 'DVD').cents).toBe(183)
    expect(estimateSellingFee('eBay', 1200, 1, 'console').cents).toBe(128)
    expect(estimateSellingFee('eBay', 1200, 1, 'collectible').cents).toBe(203)
  })
  it('estimates Amazon Individual per-item and known category fees', () => {
    expect(estimateSellingFee('Amazon', 1000, 1, 'DVD').cents).toBe(429)
    expect(estimateSellingFee('Amazon', 2000, 2, 'video game').cents).toBe(858)
    expect(estimateSellingFee('Amazon', 1000, 1, 'Video Game Console').cents).toBe(359)
    const unknown=estimateSellingFee('Amazon',1000,1,'Other')
    expect(unknown.cents).toBe(99);expect(unknown.complete).toBe(false)
  })
  it('does not invent Amazon FBA fulfillment fees or missing price estimates', () => {
    const fba=estimateSellingFee('Amazon',1000,1,'DVD','fba')
    expect(fba.cents).toBe(429);expect(fba.label).toContain('FBA fulfillment fees are not included');expect(fba.complete).toBe(false)
    expect(estimateSellingFee('eBay',null,1,'DVD').cents).toBeNull()
    expect(defaultSellerShippingCents('Amazon','seller')).toBeNull()
    expect(defaultSellerShippingCents('Amazon','fba')).toBe(0)
  })
})
