export type AmazonFulfillment = 'seller' | 'fba'
export type Estimate = { cents: number | null; label: string; complete: boolean }

const key = (value: string) => value.toLowerCase().replaceAll(/[^a-z0-9]+/g, ' ').trim()

export function defaultSellerShippingCents(platform: string, fulfillment: AmazonFulfillment = 'seller'): number | null {
  const name = key(platform)
  if (name === 'amazon') return fulfillment === 'fba' ? 0 : null
  return ['vinted','world of books','vintage stock','other','other local','local','local sale','ebay'].includes(name) ? 0 : null
}

/** Estimates are advisory and use only user-entered sale price and known category. */
export function estimateSellingFee(platform: string, amountCents: number | null, quantity: number, category = '', fulfillment: AmazonFulfillment = 'seller'): Estimate {
  const name = key(platform)
  if (['vinted', 'world of books', 'vintage stock', 'other', 'other local', 'local', 'local sale'].includes(name)) return { cents: 0, label: 'This platform defaults to $0; edit if this transaction had fees.', complete: true }
  if (amountCents === null || !Number.isSafeInteger(amountCents) || amountCents < 0 || !Number.isSafeInteger(quantity) || quantity < 1) return { cents: null, label: 'Enter the sale amount to estimate fees.', complete: false }
  if (name === 'ebay') {
    const cat = key(category)
    const rate = /console/.test(cat) ? 0.0735 : /dvd|movie|music|book|media/.test(cat) ? 0.153 : 0.136
    const cents = Math.round(amountCents * rate) + (amountCents <= 1000 ? 30 : 40)
    return { cents, label: `Estimate: ${(rate * 100).toFixed(2)}% category rate plus per-order fee. Actual fee may include buyer shipping/tax; edit to actual.`, complete: true }
  }
  if (name === 'amazon') {
    const cat = key(category)
    const media = /dvd|movie|music|book|software/.test(cat)
    const videoGame = /video game|gaming accessory|game accessory/.test(cat)
    const console = /console/.test(cat)
    const referral = console ? 0.08 : media || videoGame ? 0.15 : null
    const perItem = 99 + ((media || videoGame || console) ? 180 : 0)
    const cents = perItem * quantity + (referral === null ? 0 : Math.round(amountCents * referral))
    const categoryText = referral === null ? 'Category is unknown, so this includes only the $0.99 Individual per-item fee.' : `$${(perItem / 100).toFixed(2)}/unit Individual and closing fees plus ${(referral * 100).toFixed(0)}% category referral estimate.`
    return { cents, label: `${categoryText} ${fulfillment === 'fba' ? 'FBA fulfillment fees are not included because size/weight rates are unknown.' : 'Buyer shipping is not included in the fee basis.'} Edit to actual.`, complete: referral !== null && fulfillment !== 'fba' }
  }
  return { cents: null, label: 'No fee default is configured for this platform. Enter actual fees.', complete: false }
}
