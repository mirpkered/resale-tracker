import type { TrackerData } from './domain'
import { PLATFORMS } from './domain'

export const sampleFixture: TrackerData = {
  lots: [
    { id: 'lot-dvd', name: 'Media Collection Purchase', date: '2025-06-12', source: 'Local thrift store', purchaseCents: 1800, expensesCents: 0 },
    { id: 'lot-bins', name: 'Clothing & Games Purchase', date: '2025-06-18', source: 'Community sale', purchaseCents: 2750, expensesCents: 0 },
  ],
  items: [
    { id: 'item-1', title: 'Studio Ghibli DVD Collection', category: 'Movies', quantity: 1, originalQuantity: 1, lotId: 'lot-dvd', costCents: 800, askingCents: 2499, platform: 'eBay', status: 'active', listedOn: '2026-11-01', image: 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=600&q=80' },
    { id: 'item-2', title: 'Vintage denim jacket', category: 'Clothing', quantity: 1, originalQuantity: 1, lotId: 'lot-bins', costCents: 1200, askingCents: 3800, platform: 'Vinted', status: 'draft' },
    { id: 'item-3', title: 'Nintendo DS game bundle', category: 'Games', quantity: 2, originalQuantity: 2, lotId: 'lot-bins', costCents: 2000, askingCents: 4500, platform: 'Local Sale', status: 'acquired' },
    { id: 'item-4', title: 'Retro DVD player', category: 'Electronics', quantity: 0, originalQuantity: 1, lotId: 'lot-dvd', costCents: 700, askingCents: 0, platform: 'eBay', status: 'completed' },
  ],
  sales: [
    { id: 'sale-demo', date: '2026-11-02', platform: 'eBay', grossCents: 1800, feeCents: 260, shippingCents: 350, otherExpenseCents: 0, paymentStatus: 'paid', receivedCents: 1190, refundCents: 0, creditCents: 0, itemIds: ['item-4'], lines: [{itemId:'item-4',quantity:1,allocatedCostCents:700,proceedsCents:1190}], status: 'completed' },
  ],
  expenses: [], credit: [], platforms: PLATFORMS,
}