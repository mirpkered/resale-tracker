import { describe, expect, it } from 'vitest'
import type { LedgerTransaction, Sale, TrackerData } from './domain'
import { analyzeFinancialCommand, applyFinancialCommand, currentFinancialAmount, parseFinancialAmount } from './financialVoiceCommand'
import { analyzeVoiceCommand } from './voiceCommand'

const pending: LedgerTransaction = {
  id:'wob-pending',externalSource:'migration',externalId:'PENDING-GW-WOB-001',type:'pending_offer',date:'',platform:'World of Books',lotId:'goodwill',
  grossCents:0,feesCents:0,expensesCents:0,receivedCents:0,creditCents:0,expectedCents:4269,paymentStatus:'pending',notes:'Pending receipt and review.',fieldVerification:{expectedCents:'pending',paymentStatus:'pending'},
}
const fixture = (): TrackerData => ({
  lots:[{id:'goodwill',name:'Goodwill Outlet — November 2026',date:'2026-11-01',source:'Goodwill',purchaseCents:10015,expensesCents:0}],
  items:[],units:[],sales:[],expenses:[],credit:[],platforms:[],ledgerTransactions:[pending],
})

describe('financial voice command proposals',()=>{
  it('parses exact spoken dollars and cents and common separated speech',()=>{
    expect(parseFinancialAmount('thirty-six dollars and forty-nine cents')?.amountCents).toBe(3649)
    expect(parseFinancialAmount('thirty-six forty-nine')?.amountCents).toBe(3649)
    expect(parseFinancialAmount('36 point 49')?.amountCents).toBe(3649)
    expect(parseFinancialAmount('$36.49')?.amountCents).toBe(3649)
  })
  it('keeps concatenated and spaced digits ambiguous for explicit amount selection',()=>{
    expect(parseFinancialAmount('payout ended up being 3649')?.choicesCents).toEqual([3649,364900])
    expect(parseFinancialAmount('payout ended up being 36 49')?.choicesCents).toEqual([3649,364900])
  })
  it('matches the existing World of Books pending offer without creating another payout',()=>{
    const result=analyzeVoiceCommand('My World of Books payout ended up being thirty-six dollars and forty-nine cents. Can you update that?',fixture(),'command-1')
    expect(result.kind).toBe('financial')
    if(result.kind==='financial'){
      expect(result.command.action).toBe('update_payout_amount')
      expect(result.matches.map((entry)=>entry.id)).toEqual(['wob-pending'])
      expect(result.matchedLot?.id).toBe('goodwill')
      expect(result.command.amountCents).toBe(3649)
      expect(result.command.explicitReceipt).toBe(false)
    }
  })
  it('previews an amount correction as pending and changes only the matched record after confirmation',()=>{
    const data=fixture(),analysis=analyzeFinancialCommand('Change the Goodwill World of Books payout to $36.49.',data,'cmd-update')!
    const unchanged=JSON.stringify(data)
    expect(analysis.matches[0].expectedCents).toBe(4269)
    expect(JSON.stringify(data)).toBe(unchanged)
    const result=applyFinancialCommand(data,analysis.command,3649,'wob-pending',false,'2026-11-10')
    expect(result.duplicate).toBe(false)
    expect(result.data.ledgerTransactions).toHaveLength(1)
    expect(result.data.ledgerTransactions?.[0]).toMatchObject({id:'wob-pending',type:'pending_offer',expectedCents:3649,receivedCents:0,paymentStatus:'pending'})
  })
  it('moves the existing pending offer to received cash only for an explicit received command',()=>{
    const data=fixture(),analysis=analyzeFinancialCommand('World of Books paid me $36.49.',data,'cmd-paid')!
    expect(analysis.command.action).toBe('mark_payout_received')
    const result=applyFinancialCommand(data,analysis.command,3649,'wob-pending',true,'2026-11-10')
    expect(result.data.ledgerTransactions).toHaveLength(1)
    expect(result.data.ledgerTransactions?.[0]).toMatchObject({id:'wob-pending',type:'buyback_payout',grossCents:3649,receivedCents:3649,expectedCents:0,paymentStatus:'confirmed'})
  })
  it('uses the current expected amount when explicitly marking an existing payment received without a new amount',()=>{
    const analysis=analyzeFinancialCommand('Mark my World of Books payment as received.',fixture(),'cmd-received')!
    expect(currentFinancialAmount(analysis,'wob-pending')).toBe(4269)
  })
  it('does not invent a payout or edit records for an unmatched correction',()=>{
    const data=fixture(),analysis=analyzeFinancialCommand('Change my Staples payout to $10.00.',data,'cmd-no-match')!
    expect(analysis.matches).toHaveLength(0)
    expect(analysis.message).toMatch(/No existing/)
    expect(()=>applyFinancialCommand(data,analysis.command,1000)).toThrow(/no longer matches/)
    expect(data.ledgerTransactions).toEqual([pending])
  })
  it('separates store credit from cash and keeps an expense as cash out',()=>{
    const data=fixture()
    const credit=analyzeFinancialCommand('I received ten dollars in Vintage Stock credit.',data,'cmd-credit')!
    const withCredit=applyFinancialCommand(data,credit.command,1000,undefined,true,'2026-11-10').data
    expect(withCredit.ledgerTransactions?.at(-1)).toMatchObject({type:'store_credit',creditCents:1000,receivedCents:0,creditDirection:'issued'})
    const expense=analyzeFinancialCommand('I spent four dollars on eBay shipping.',withCredit,'cmd-expense')!
    const withExpense=applyFinancialCommand(withCredit,expense.command,400,undefined,true,'2026-11-10').data
    expect(withExpense.ledgerTransactions?.at(-1)).toMatchObject({type:'other_expense',expensesCents:400,receivedCents:0})
  })
  it('makes reapplying the same command idempotent',()=>{
    const data=fixture(),analysis=analyzeFinancialCommand('I received ten dollars in Vintage Stock credit.',data,'cmd-repeat')!
    const first=applyFinancialCommand(data,analysis.command,1000,undefined,true,'2026-11-10')
    const second=applyFinancialCommand(first.data,analysis.command,1000,undefined,true,'2026-11-10')
    expect(second.duplicate).toBe(true)
    expect(second.data.ledgerTransactions).toHaveLength(2)
  })
  it('previews and confirms a fee correction against one existing paid sale without changing inventory',()=>{
    const sale:Sale={id:'sale-1',date:'2026-11-09',platform:'eBay',grossCents:1000,feeCents:100,shippingCents:0,otherExpenseCents:0,paymentStatus:'paid',receivedCents:900,refundCents:0,creditCents:0,itemIds:['item-1'],status:'completed',fieldVerification:{feeCents:'confirmed',receivedCents:'confirmed'}}
    const data={...fixture(),items:[{id:'item-1',title:'Strawberry Panic Complete Collection',category:'book',quantity:1,lotId:'goodwill',costCents:300,askingCents:1000,platform:'eBay',status:'completed' as const}],sales:[sale]}
    const analysis=analyzeFinancialCommand('Change eBay fee for Strawberry Panic to $1.50.',data,'cmd-fee')!
    expect(analysis.command.action).toBe('update_sale_expense')
    expect(analysis.sales.map((entry)=>entry.id)).toEqual(['sale-1'])
    const result=applyFinancialCommand(data,analysis.command,150,'sale-1',false,'2026-11-10')
    expect(result.data.sales[0]).toMatchObject({id:'sale-1',feeCents:150,receivedCents:850,paymentStatus:'paid'})
    expect(result.data.items[0].costCents).toBe(300)
    expect(data.sales[0].feeCents).toBe(100)
  })
  it('rejects sale expense corrections that exceed the sale gross',()=>{
    const sale:Sale={id:'sale-1',date:'2026-11-09',platform:'eBay',grossCents:1000,feeCents:100,shippingCents:0,otherExpenseCents:0,paymentStatus:'paid',receivedCents:900,refundCents:0,creditCents:0,itemIds:['item-1'],status:'completed'}
    const data={...fixture(),items:[{id:'item-1',title:'Strawberry Panic Collection',category:'book',quantity:1,lotId:'goodwill',costCents:300,askingCents:1000,platform:'eBay',status:'completed' as const}],sales:[sale]}
    const analysis=analyzeFinancialCommand('Update eBay fee for Strawberry Panic to $11.00.',data,'cmd-fee-invalid')!
    expect(()=>applyFinancialCommand(data,analysis.command,1100,'sale-1')).toThrow(/exceed the sale amount/)
  })
})
