import { describe, expect, it } from 'vitest'
import { allocateCents, allocatedCostCents, dollarsToCents, getMetrics, importPreview, lineNetProceedsCents, lotTotalCents, lotUnallocatedCents, parseImport, parseImportText, retainedCostCents, saleNetCents, storeCreditBalanceCents, transitionStatus } from './domain'
import type { TrackerData } from './domain'

const fixture: TrackerData = {
  lots: [{id:'lot-a',name:'Books',date:'2026-10-01',source:'Sale',purchaseCents:10000,expensesCents:500}],
  items: [
    {id:'book-a',title:'Book A',category:'Books',quantity:1,originalQuantity:2,lotId:'lot-a',costCents:6000,askingCents:2500,platform:'eBay',status:'active'},
    {id:'book-b',title:'Book B',category:'Books',quantity:0,originalQuantity:1,lotId:'lot-a',costCents:3000,askingCents:1800,platform:'Vinted',status:'completed'},
  ],
  sales: [
    {id:'paid',date:'2026-10-02',platform:'eBay',grossCents:5000,feeCents:500,shippingCents:400,otherExpenseCents:100,paymentStatus:'paid',receivedCents:4000,refundCents:500,creditCents:0,itemIds:['book-a'],lines:[{itemId:'book-a',quantity:1,allocatedCostCents:3000,proceedsCents:4000}],status:'completed'},
    {id:'unpaid',date:'2026-10-03',platform:'Vinted',grossCents:2000,feeCents:200,shippingCents:0,otherExpenseCents:0,paymentStatus:'unpaid',receivedCents:0,refundCents:0,creditCents:0,itemIds:['book-b'],lines:[{itemId:'book-b',quantity:1,allocatedCostCents:3000,proceedsCents:1800}],status:'completed'},
  ],
  expenses:[{id:'packing',date:'2026-10-02',amountCents:250,description:'Packing materials'}],
  credit:[{id:'credit-1',date:'2026-10-02',kind:'issued',amountCents:1200,description:'Trade-in'},{id:'credit-2',date:'2026-10-03',kind:'redeemed',amountCents:300,description:'Store purchase'}],
  platforms:[],
}

describe('exact cents and lot accounting',()=>{
  it('parses decimal amounts without binary floating point',()=>{expect(dollarsToCents('54.78')).toBe(5478);expect(dollarsToCents('0.09')).toBe(9);expect(()=>dollarsToCents('2.005')).toThrow()})
  it('totals purchase lot price plus additional acquisition expenses',()=>{expect(lotTotalCents(fixture.lots[0])).toBe(10500)})
  it('reconciles allocations and exposes the remainder',()=>{expect(allocatedCostCents(fixture,'lot-a')).toBe(9000);expect(lotUnallocatedCents(fixture,fixture.lots[0])).toBe(1500)})
  it('keeps actual cash investment separate from explicitly rounded item allocations',()=>{const lot={id:'rounding-test',name:'Rounding test',date:'2026-11-07',source:'Test source',purchaseCents:100,expensesCents:0,allocationRoundingAdjustmentCents:2};const items=Array.from({length:3},(_,index)=>({id:`rounding-${index}`,title:`Test item ${index}`,category:'Other',quantity:1,lotId:'rounding-test',costCents:34,askingCents:500,minimumOfferCents:300,platform:'Test platform',status:'draft' as const}));const data={...fixture,lots:[lot],items,sales:[],expenses:[],credit:[]};expect(allocatedCostCents(data,'rounding-test')).toBe(102);expect(lotUnallocatedCents(data,lot)).toBe(0);expect(getMetrics(data).purchaseInvestmentCents).toBe(100);expect(getMetrics(data).overallCashPositionCents).toBe(-100);expect(getMetrics(data).remainingInventoryCostCents).toBe(102);expect(getMetrics(data).unsoldAskingCents).toBe(1500)})
})

describe('sales and cash accounting',()=>{
  it('calculates net proceeds after fees, shipping, expenses, and partial refunds',()=>{expect(saleNetCents(fixture.sales[0])).toBe(3500)})
  it('counts only confirmed paid proceeds as received cash',()=>{const m=getMetrics(fixture);expect(m.netCashProceedsCents).toBe(3500);expect(m.overallCashPositionCents).toBe(3500-10500-250)})
  it('does not realize profit for an unpaid sale',()=>{expect(getMetrics(fixture).realizedItemProfitCents).toBe(3500-3000)})
  it('uses allocated quantity cost and proceeds for partial and bundled sales',()=>{const bundle={...fixture.sales[0],id:'bundle',grossCents:8000,feeCents:400,shippingCents:300,otherExpenseCents:0,refundCents:0,itemIds:['book-a','book-b'],lines:[{itemId:'book-a',quantity:1,allocatedCostCents:3000,proceedsCents:4500},{itemId:'book-b',quantity:1,allocatedCostCents:3000,proceedsCents:2800}]};expect(bundle.lines!.reduce((sum,line)=>sum+lineNetProceedsCents(bundle,line)-line.allocatedCostCents,0)).toBe(1300)})
  it('allocates every cent exactly across bundle lines',()=>{expect(allocateCents(100,[1,1,1])).toEqual([34,33,33]);expect(allocateCents(10,[0,0])).toEqual([5,5])})
  it('restores cost to inventory on a returned line while preserving the sale and refund history',()=>{const line={itemId:'book-a',quantity:2,allocatedCostCents:6000,proceedsCents:7000,returnedQuantity:1};expect(retainedCostCents(line)).toBe(3000);const returned={...fixture.sales[0],grossCents:7000,feeCents:0,shippingCents:0,otherExpenseCents:0,refundCents:3500,lines:[line]};expect(lineNetProceedsCents(returned,line)).toBe(3500)})
  it('keeps store credit separate from cash',()=>{expect(storeCreditBalanceCents(fixture)).toBe(900);expect(getMetrics(fixture).netCashProceedsCents).toBe(3500)})
  it('reports remaining quantity, allocated cost, and potential asking separately',()=>{const m=getMetrics(fixture);expect(m.remainingQuantity).toBe(1);expect(m.remainingInventoryCostCents).toBe(3000);expect(m.unsoldAskingCents).toBe(2500)})
  it('tracks retained inventory separately from saleable stock and realized profit',()=>{const retained={id:'kept',title:'Kept copy',category:'Books',quantity:1,lotId:'lot-a',costCents:1500,askingCents:0,platform:'Other',status:'retained' as const};const data={...fixture,items:[...fixture.items,retained]};const metrics=getMetrics(data);expect(metrics.remainingQuantity).toBe(1);expect(metrics.retainedQuantity).toBe(1);expect(metrics.remainingInventoryCostCents).toBe(3000);expect(metrics.retainedInventoryCostCents).toBe(1500);expect(metrics.realizedItemProfitCents).toBe(500)})
})

describe('imports and inventory lifecycle',()=>{
  const payload=`{"schemaVersion":"1.0","source":"chat-project","records":[{"sourceId":"abc-1","title":"Game","quantity":1,"suggestedPrice":"12.00"}]}`
  it('previews first import as create and repeated source IDs as update',()=>{const parsed=parseImport(payload);expect(importPreview(fixture,parsed)[0].action).toBe('create');const prior={...fixture,items:[...fixture.items,{id:'external',title:'Game',category:'Other',quantity:1,lotId:null,costCents:0,askingCents:1200,platform:'Other',status:'acquired' as const,notes:'[source:chat-project:abc-1]'}]};expect(importPreview(prior,parsed)[0].action).toBe('update')})
  it('does not count a suggested asking price as unsold asking value',()=>{const item={id:'suggested',title:'Game',category:'Games',quantity:1,lotId:null,costCents:0,askingCents:0,suggestedAskingCents:1200,platform:'eBay',status:'acquired' as const};expect(getMetrics({...fixture,items:[item],sales:[]}).unsoldAskingCents).toBe(0)})
  it('rejects invalid and duplicated import records',()=>{expect(()=>parseImport('{"schemaVersion":"0","source":"x","records":[]}')).toThrow();expect(()=>parseImport('{"schemaVersion":"1.0","source":"x","records":[{"sourceId":"a","title":"A"},{"sourceId":"a","title":"B"}]}')).toThrow()})
  it('maps legacy draft statuses to unlisted while preserving import compatibility',()=>{const result=parseImport('{"schemaVersion":"1.0","source":"legacy","records":[{"sourceId":"a","title":"DVD","status":"draft"}]}');expect(result.records[0].status).toBe('acquired')})
  it('validates CSV imports with stable source IDs and quoted fields',()=>{const csv='source,sourceId,title,category,quantity,suggestedPrice,notes\nchat,a-1,"Book, First Edition",Books,1,14.50,"keep, clean"';const result=parseImportText(csv);expect(result.source).toBe('chat');expect(result.records[0].title).toBe('Book, First Edition');expect(result.records[0].suggestedPrice).toBe('14.50')})
  it('requires a listing confirmation before acquired items become active',()=>{expect(transitionStatus('acquired','active')).toBe('active');expect(()=>transitionStatus('completed','active')).toThrow();expect(transitionStatus('completed','returned')).toBe('returned')})
  it('moves held inventory into and out of retained status explicitly',()=>{expect(transitionStatus('acquired','retained')).toBe('retained');expect(transitionStatus('retained','active')).toBe('active');expect(()=>transitionStatus('awaiting_payment','retained')).toThrow()})
})
