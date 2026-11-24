import { describe, expect, it } from 'vitest'
import { getMetrics } from './domain'
import type { TrackerData } from './domain'
import { correctExistingSale, quickSalePriceDefault, recordBundleSale, recordQuickSale } from './quickSale'
import { itemSales, realizedLotProfitCents, summarizeLot } from './lotView'
import { realizedProfitBreakdown } from './financialBreakdown'

const fixture = (askingCents = 1200, quantity = 1): TrackerData => ({
  lots: [{ id: 'lot', name: 'Games', date: '2026-11-01', source: 'Outlet', purchaseCents: 500, expensesCents: 0 }],
  items: [{ id: 'game', title: 'Duplicate cartridge', category: 'Games', quantity, originalQuantity: quantity, lotId: 'lot', costCents: 500 * quantity, askingCents, platform: 'Vinted', status: 'active' }],
  units: Array.from({ length: quantity }, (_, i) => ({ id: `copy-${i + 1}`, itemId: 'game', copyNumber: i + 1, status: 'active' as const })),
  sales: [], expenses: [], credit: [], platforms: [{ id: 'vinted', name: 'Vinted', kind: 'sales' }],
})
const input = (grossCents: number, feeCents = 0) => ({ date: '2026-11-05', platform: 'Vinted', grossCents, feeCents, shippingCents: 0, otherExpenseCents: 0 })
const ids = (() => { let index = 0; return () => `new-${++index}` })()

describe('quick sale', () => {
  it('records a three-item bundle as one $9 transaction with three lines and three unit deductions',()=>{
    const data=fixture(0,1),items=[data.items[0],{...data.items[0],id:'game-b',title:'Second title',costCents:100,quantity:1},{...data.items[0],id:'game-c',title:'Third title',costCents:100,quantity:1}]
    data.items=items;data.units=['game','game-b','game-c'].map((itemId,index)=>({id:`bundle-unit-${index}`,itemId,copyNumber:1,status:'active' as const}))
    const makeId=(()=>{let n=0;return()=>`bundle-id-${++n}`})()
    const result=recordBundleSale(data,items.map((item)=>({itemId:item.id,quantity:1})),{date:'2026-11-21',platform:'Vinted',grossCents:900,feeCents:0,shippingCents:0,otherExpenseCents:0,paymentReceived:true,externalSource:'voice-command',externalId:'bundle-command-9'},makeId)
    expect(result.sale.grossCents).toBe(900)
    expect(result.sale.itemIds).toEqual(['game','game-b','game-c'])
    expect(result.sale.lines).toHaveLength(3)
    expect(result.sale.lines?.every((line)=>line.proceedsCents===undefined)).toBe(true)
    expect(result.data.items.map((item)=>item.quantity)).toEqual([0,0,0])
    expect(result.data.units?.map((unit)=>unit.status)).toEqual(['completed','completed','completed'])
    expect(getMetrics(result.data).netCashProceedsCents).toBe(900)
    expect(getMetrics(result.data).overallCashPositionCents).toBe(900-500)
    expect(getMetrics(result.data).realizedItemProfitCents).toBe(0)
    expect(realizedProfitBreakdown(result.data)[0]).toMatchObject({proceedsCents:900,profitCents:null,complete:false})
    expect(itemSales(result.data,items[0])[0]).toMatchObject({grossCents:900,proceedsAllocated:false})
    expect(summarizeLot(result.data,data.lots[0]).grossConfirmedSalesCents).toBe(900)
    expect(summarizeLot(result.data,data.lots[0]).cashReceivedCents).toBe(900)
    expect(realizedLotProfitCents(result.data,'lot')).toBe(0)
  })

  it('keeps bundle marketplace proceeds pending and applies shared fees once until receipt is confirmed',()=>{
    const data=fixture(0,1),second={...data.items[0],id:'second',title:'Second DVD',costCents:100};data.items.push(second);data.units?.push({id:'copy-second',itemId:'second',copyNumber:1,status:'active'})
    const result=recordBundleSale(data,[{itemId:'game',quantity:1},{itemId:'second',quantity:1}],{date:'2026-11-21',platform:'eBay',grossCents:900,feeCents:100,shippingCents:50,otherExpenseCents:0,externalSource:'voice-command',externalId:'pending-bundle'})
    expect(result.sale.paymentStatus).toBe('unpaid')
    expect(result.sale.receivedCents).toBe(0)
    expect(result.sale.feeCents).toBe(100)
    expect(result.sale.shippingCents).toBe(50)
    expect(getMetrics(result.data).netCashProceedsCents).toBe(0)
    expect(getMetrics(result.data).expectedFutureProceedsCents).toBe(750)
    expect(result.data.items.map((item)=>item.status)).toEqual(['awaiting_payment','awaiting_payment'])
  })

  it('supports cross-lot bundle lines and rejects retries without duplicating the sale',()=>{
    const data=fixture(0,1),secondLot={id:'lot-b',name:'Other lot',date:'2026-11-02',source:'Yard sale',purchaseCents:100,expensesCents:0},second={...data.items[0],id:'second',title:'Second lot DVD',lotId:'lot-b',costCents:100}
    data.lots.push(secondLot);data.items.push(second);data.units?.push({id:'copy-second',itemId:'second',copyNumber:1,status:'active'})
    const input={date:'2026-11-21',platform:'Vinted',grossCents:500,feeCents:0,shippingCents:0,otherExpenseCents:0,externalSource:'voice-command',externalId:'cross-lot-bundle'}
    const first=recordBundleSale(data,[{itemId:'game',quantity:1},{itemId:'second',quantity:1}],input)
    const retry=recordBundleSale(first.data,[{itemId:'game',quantity:1},{itemId:'second',quantity:1}],input)
    expect(first.sale.lines?.map((line)=>line.itemId)).toEqual(['game','second'])
    expect(first.sale.grossCents).toBe(500)
    expect(retry.duplicate).toBe(true)
    expect(retry.data.sales).toHaveLength(1)
    expect(summarizeLot(first.data,data.lots[0]).grossConfirmedSalesCents).toBe(0)
    expect(summarizeLot(first.data,secondLot).grossConfirmedSalesCents).toBe(0)
    expect(getMetrics(first.data).netCashProceedsCents).toBe(0)
  })

  it('keeps unknown bundle line proceeds unallocated when correcting the shared total',()=>{
    const data=fixture(0,1),second={...data.items[0],id:'second',title:'Second DVD',costCents:100};data.items.push(second);data.units?.push({id:'copy-second',itemId:'second',copyNumber:1,status:'active'})
    const created=recordBundleSale(data,[{itemId:'game',quantity:1},{itemId:'second',quantity:1}],{date:'2026-11-21',platform:'Vinted',grossCents:900,feeCents:0,shippingCents:0,otherExpenseCents:0,paymentReceived:true,externalSource:'voice-command',externalId:'correct-unallocated'})
    const corrected=correctExistingSale(created.data,created.sale.id,{date:'2026-11-21',platform:'Vinted',grossCents:850,feeCents:0,shippingCents:0,otherExpenseCents:0,paid:true})
    expect(corrected.sales[0].grossCents).toBe(850)
    expect(corrected.sales[0].lines?.every((line)=>line.proceedsCents===undefined)).toBe(true)
    expect(getMetrics(corrected).realizedItemProfitCents).toBe(0)
  })

  it('prefills with the original asking price and leaves a blank required value when absent', () => {
    expect(quickSalePriceDefault(1234)).toBe('12.34')
    expect(quickSalePriceDefault(0)).toBe('')
    expect(quickSalePriceDefault(-1)).toBe('')
  })
  it('records an asking-price sale as paid cash and updates item and lot totals immediately', () => {
    const result = recordQuickSale(fixture(), 'game', input(1200, 100), ids)
    expect(result.sale.grossCents).toBe(1200)
    expect(result.sale.paymentStatus).toBe('paid')
    expect(result.data.items[0].askingCents).toBe(1200)
    expect(result.data.items[0].quantity).toBe(0)
    expect(result.data.units?.[0].status).toBe('completed')
    expect(getMetrics(result.data).netCashProceedsCents).toBe(1100)
    expect(getMetrics(result.data).overallCashPositionCents).toBe(600)
    expect(getMetrics(result.data).realizedItemProfitCents).toBe(600)
  })

  it('accepts a lower offer without overwriting the original asking price', () => {
    const result = recordQuickSale(fixture(), 'game', input(800), ids)
    expect(result.data.items[0].askingCents).toBe(1200)
    expect(result.sale.grossCents).toBe(800)
    expect(getMetrics(result.data).netCashProceedsCents).toBe(800)
  })

  it('supports a user-entered amount when no asking price exists', () => {
    const result = recordQuickSale(fixture(0), 'game', input(450), ids)
    expect(result.sale.grossCents).toBe(450)
    expect(getMetrics(result.data).netCashProceedsCents).toBe(450)
  })

  it('tracks duplicate copies as distinct units and does not resell a completed unit', () => {
    const initial = fixture(1200, 2)
    const first = recordQuickSale(initial, 'game', input(1200), ids)
    expect(first.unit.id).toBe('copy-1')
    expect(first.data.units?.find((unit) => unit.id === 'copy-2')?.status).toBe('active')
    const second = recordQuickSale(first.data, 'game', input(900), ids)
    expect(second.unit.id).toBe('copy-2')
    expect(second.data.sales).toHaveLength(2)
    expect(() => recordQuickSale(second.data, 'game', input(900), ids)).toThrow(/no available inventory unit/)
  })

  it('rejects negative amounts and expenses that exceed gross proceeds', () => {
    expect(() => recordQuickSale(fixture(), 'game', input(-1), ids)).toThrow(/nonnegative sale amount/)
    expect(() => recordQuickSale(fixture(), 'game', { ...input(100), feeCents: 101 }, ids)).toThrow(/cannot exceed/)
  })

  it('corrects an existing sale in place without creating a duplicate transaction', () => {
    const first = recordQuickSale(fixture(), 'game', input(1200), ids)
    const corrected = correctExistingSale(first.data, first.sale.id, { date: '2026-11-05', platform: 'Local Sale', grossCents: 900, feeCents: 100, shippingCents: 0, otherExpenseCents: 0, paid: true })
    expect(corrected.sales).toHaveLength(1)
    expect(corrected.sales[0].id).toBe(first.sale.id)
    expect(corrected.sales[0].grossCents).toBe(900)
    expect(corrected.sales[0].platform).toBe('Local Sale')
    expect(getMetrics(corrected).netCashProceedsCents).toBe(800)
    expect(getMetrics(corrected).realizedItemProfitCents).toBe(300)
  })

  it('preserves historical miscellaneous expenses when recording a new sale with no added expense', () => {
    const initial=fixture(1200,2)
    const prior=recordQuickSale(initial, 'game', {...input(1200), otherExpenseCents:125}, ids)
    const next=recordQuickSale(prior.data, 'game', input(900), ids)
    expect(next.data.sales[1].otherExpenseCents).toBe(125)
    expect(next.data.sales[0].otherExpenseCents).toBe(0)
  })
})

