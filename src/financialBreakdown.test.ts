import { describe, expect, it } from 'vitest'
import { getMetrics, type TrackerData } from './domain'
import { acquisitionBreakdown, cashPositionBreakdown, cashReceivedBreakdown, pendingProceedsBreakdown, realizedProfitBreakdown } from './financialBreakdown'

function fixture():TrackerData{
  const item={id:'item-a',title:'Sold book',category:'Books',quantity:0,originalQuantity:1,lotId:'lot-a',costCents:400,askingCents:0,platform:'eBay',status:'completed' as const,fieldVerification:{costCents:'confirmed' as const}}
  return {lots:[{id:'lot-a',name:'Confirmed lot',date:'2026-11-01',source:'Sale',purchaseCents:1000,expensesCents:100},{id:'lot-b',name:'Estimated lot',date:'2026-11-02',source:'Import',purchaseCents:2000,expensesCents:0,fieldVerification:{purchaseCents:'estimated'}}],items:[item],units:[],sales:[{id:'sale-a',date:'2026-11-03',platform:'eBay',grossCents:1000,feeCents:100,shippingCents:0,otherExpenseCents:0,paymentStatus:'paid',receivedCents:900,refundCents:0,creditCents:0,itemIds:[item.id],lines:[{itemId:item.id,quantity:1,allocatedCostCents:400,proceedsCents:900}],status:'completed',fieldVerification:{receivedCents:'confirmed',grossCents:'confirmed',feeCents:'confirmed'}} ,{id:'sale-pending',date:'2026-11-04',platform:'Vinted',grossCents:500,feeCents:50,shippingCents:0,otherExpenseCents:0,paymentStatus:'unpaid',receivedCents:0,refundCents:0,creditCents:0,itemIds:[],status:'completed',fieldVerification:{grossCents:'confirmed'}}],expenses:[],credit:[],platforms:[],ledgerTransactions:[{id:'payout',externalSource:'test',externalId:'payout',type:'buyback_payout',date:'2026-11-03',platform:'Vintage Stock',lotId:'lot-a',grossCents:300,feesCents:0,expensesCents:0,receivedCents:300,creditCents:0,expectedCents:0,paymentStatus:'confirmed',fieldVerification:{receivedCents:'confirmed'}},{id:'pending',externalSource:'test',externalId:'pending',type:'pending_offer',date:'2026-11-04',platform:'World of Books',lotId:'lot-a',grossCents:0,feesCents:0,expensesCents:0,receivedCents:0,creditCents:0,expectedCents:700,paymentStatus:'pending',fieldVerification:{expectedCents:'pending'}},{id:'cost',externalSource:'test',externalId:'cost',type:'other_expense',date:'2026-11-03',platform:'eBay',lotId:'lot-a',grossCents:0,feesCents:0,expensesCents:50,receivedCents:0,creditCents:0,expectedCents:0,paymentStatus:'confirmed',fieldVerification:{expensesCents:'confirmed'}},{id:'allocated-sale',externalSource:'test',externalId:'allocated-sale',type:'cash_sale',date:'2026-11-01',platform:'Local Sale',lotId:'lot-a',grossCents:300,feesCents:0,expensesCents:0,receivedCents:300,creditCents:0,expectedCents:0,paymentStatus:'confirmed',saleAllocatedCostCents:[100],saleAllocatedProceedsCents:[300],saleCostVerified:[true],fieldVerification:{receivedCents:'confirmed'}}]}
}

describe('dashboard financial detail selectors',()=>{
  it('reconciles purchase investment, cash, pending proceeds, profit, and lot position to dashboard selectors',()=>{
    const data=fixture(),metrics=getMetrics(data),acquisition=acquisitionBreakdown(data),cash=cashReceivedBreakdown(data),pending=pendingProceedsBreakdown(data),profit=realizedProfitBreakdown(data),position=cashPositionBreakdown(data)
    expect(acquisition.confirmedTotalCents).toBe(metrics.purchaseInvestmentCents)
    expect(acquisition.estimatedTotalCents).toBe(metrics.estimatedAcquisitionCostCents)
    expect(cash.reduce((sum,row)=>sum+row.receivedCents,0)).toBe(metrics.netCashProceedsCents)
    expect(pending.reduce((sum,row)=>sum+row.amountCents,0)).toBe(metrics.expectedFutureProceedsCents)
    expect(profit.reduce((sum,row)=>sum+(row.profitCents??0),0)).toBe(metrics.realizedItemProfitCents)
    expect(position.overallConfirmedCents).toBe(metrics.overallCashPositionCents)
    expect(position.lots[0].confirmedPositionCents).toBe(metrics.overallCashPositionCents)
  })
  it('keeps cash expenses from being subtracted twice and preserves estimated acquisition caveats',()=>{
    const data=fixture(),cash=cashReceivedBreakdown(data),position=cashPositionBreakdown(data)
    expect(cash.find((row)=>row.id==='sale-a')).toMatchObject({grossCents:1000,expensesCents:100,receivedCents:900})
    expect(position.lots.find((row)=>row.lot.id==='lot-b')?.summary.estimatedInvestment).toBe(true)
    expect(position.estimatedAcquisitionCents).toBe(2000)
  })
  it('handles empty financial collections',()=>{
    const empty:TrackerData={lots:[],items:[],sales:[],expenses:[],credit:[],platforms:[]}
    expect(cashReceivedBreakdown(empty)).toEqual([])
    expect(pendingProceedsBreakdown(empty)).toEqual([])
    expect(realizedProfitBreakdown(empty)).toEqual([])
    expect(cashPositionBreakdown(empty).overallConfirmedCents).toBe(0)
  })
})
