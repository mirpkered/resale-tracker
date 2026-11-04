import { describe, expect, it } from 'vitest'
import { getMetrics, purchaseGroupTotals } from './domain'
import { applyMigration, parseMigration, previewMigration, type MigrationPayload } from './migration'

const blank={lots:[],items:[],sales:[],expenses:[],credit:[],platforms:[]}
const basePayload=():MigrationPayload=>({format:'resale-tracker-migration',schemaVersion:'1.0',source:{id:'verified-chat-records',name:'Verified records'},purchaseGroups:[{externalId:'fall-hauls',name:'Fall hauls',verification:{name:'confirmed'}}],purchaseLots:[
  {externalId:'lot-a',name:'Goodwill Outlet #1',date:'2026-11-01',source:'Goodwill',purchaseCents:5000,expensesCents:0,groupExternalId:'fall-hauls',verification:{name:'confirmed',date:'confirmed',source:'confirmed',purchaseCents:'confirmed',expensesCents:'confirmed',groupExternalId:'confirmed'}},
  {externalId:'lot-b',name:'Halloween DVDs',date:'2026-10-31',source:'Thrift store',purchaseCents:2300,expensesCents:0,groupExternalId:'fall-hauls',verification:{name:'confirmed',date:'confirmed',source:'confirmed',purchaseCents:'confirmed',expensesCents:'confirmed',groupExternalId:'confirmed'}},
],inventoryItems:[{externalId:'game-copies',lotExternalId:'lot-a',title:'Game copies',category:'Games',quantity:2,unitExternalIds:['copy-a','copy-b'],allocatedCostCents:3000,askingCents:0,suggestedAskingCents:1800,listingState:'draft_suggestion',verification:{title:'confirmed',quantity:'confirmed',lotExternalId:'confirmed',category:'confirmed',allocatedCostCents:'confirmed',askingCents:'unknown',suggestedAskingCents:'suggested',unitExternalIds:'confirmed',listingState:'pending'}}],transactions:[]})
const parsed=(payload:MigrationPayload)=>parseMigration(JSON.stringify(payload))

describe('verified migration and reconciliation',()=>{
  it('groups purchase lots for reporting without merging or duplicating original costs',()=>{
    const payload=parsed(basePayload()),migrated=applyMigration(blank,payload);const group=purchaseGroupTotals(migrated)[0]
    expect(migrated.lots).toHaveLength(2);expect(group.lotCount).toBe(2);expect(group.purchaseCents).toBe(7300);expect(getMetrics(migrated).purchaseInvestmentCents).toBe(7300)
  })
  it('detects stable external IDs, matching existing records, and duplicate IDs in the payload',()=>{
    const payload=parsed(basePayload()),migrated=applyMigration(blank,payload)
    expect(previewMigration(migrated,payload).every((row)=>row.status==='existing')).toBe(true)
    const modified=basePayload();modified.inventoryItems[0].title='Edited title';expect(previewMigration(migrated,parsed(modified)).find((row)=>row.kind==='inventory_item')?.status).toBe('conflict')
    const duplicate=basePayload();duplicate.transactions=[{externalId:'game-copies',type:'pending_offer',date:'2026-11-02',paymentStatus:'pending',verification:{type:'confirmed',date:'confirmed',paymentStatus:'pending'}}];expect(()=>parsed(duplicate)).toThrow(/Duplicate externalId/)
  })
  it('preserves existing user edits unless a conflicting record is explicitly approved',()=>{
    const payload=parsed(basePayload()),first=applyMigration(blank,payload);const changed=basePayload();changed.inventoryItems[0].title='Conversation title update';const changedPayload=parsed(changed);const row=previewMigration(first,changedPayload).find((entry)=>entry.kind==='inventory_item')!
    expect(row.status).toBe('conflict');expect(applyMigration(first,changedPayload).items[0].title).toBe('Game copies');expect(applyMigration(first,changedPayload,['inventory_item:game-copies']).items[0].title).toBe('Conversation title update');expect(first.items[0].title).toBe('Game copies')
  })
  it('keeps estimated costs and suggested values outside confirmed accounting totals',()=>{
    const payload=basePayload();payload.purchaseLots[0].verification.purchaseCents='estimated';payload.inventoryItems[0].verification.allocatedCostCents='estimated';const data=applyMigration(blank,parsed(payload));const metrics=getMetrics(data)
    expect(metrics.purchaseInvestmentCents).toBe(2300);expect(metrics.estimatedAcquisitionCostCents).toBe(5000);expect(metrics.unsoldAskingCents).toBe(0);expect(metrics.suggestedAskingValueCents).toBe(3600);expect(metrics.unverifiedRemainingInventoryCostCents).toBe(3000)
  })
  it('stores individual copy IDs for duplicated merchandise',()=>{const data=applyMigration(blank,parsed(basePayload()));expect(data.units).toHaveLength(2);expect(new Set(data.units?.map((unit)=>unit.externalId)).size).toBe(2);expect(data.items[0].quantity).toBe(2)})
  it('keeps suggestions in draft and only marks explicitly confirmed listings active',()=>{const draft=applyMigration(blank,parsed(basePayload()));expect(draft.items[0].status).toBe('draft');const active=basePayload();active.inventoryItems[0].listingState='confirmed_active';active.inventoryItems[0].askingCents=1600;active.inventoryItems[0].verification.listingState='confirmed';active.inventoryItems[0].verification.askingCents='confirmed';expect(applyMigration(blank,parsed(active)).items[0].status).toBe('active')})
  it('keeps pending offers as expected future proceeds and never cash received',()=>{const payload=basePayload();payload.transactions=[{externalId:'offer-1',type:'pending_offer',date:'2026-11-03',grossCents:2500,expectedCents:2500,paymentStatus:'pending',verification:{type:'confirmed',date:'confirmed',grossCents:'suggested',expectedCents:'suggested',paymentStatus:'pending'}}];const metrics=getMetrics(applyMigration(blank,parsed(payload)));expect(metrics.netCashProceedsCents).toBe(0);expect(metrics.expectedFutureProceedsCents).toBe(2500);expect(metrics.pendingOfferValueCents).toBe(2500)})
  it('reconciles cash sales, buyback payouts, expenses, credit, and offers separately',()=>{const payload=basePayload();payload.transactions=[
    {externalId:'paid-sale',type:'cash_sale',date:'2026-11-02',grossCents:3300,feesCents:300,receivedCents:3000,paymentStatus:'confirmed',verification:{type:'confirmed',date:'confirmed',grossCents:'confirmed',feesCents:'confirmed',receivedCents:'confirmed',paymentStatus:'confirmed'}},
    {externalId:'trade-in',type:'buyback_payout',date:'2026-11-03',grossCents:500,receivedCents:500,paymentStatus:'confirmed',verification:{type:'confirmed',date:'confirmed',grossCents:'confirmed',receivedCents:'confirmed',paymentStatus:'confirmed'}},
    {externalId:'credit-issued',type:'store_credit',date:'2026-11-04',creditCents:1200,creditDirection:'issued',paymentStatus:'confirmed',verification:{type:'confirmed',date:'confirmed',creditCents:'confirmed',creditDirection:'confirmed',paymentStatus:'confirmed'}},
    {externalId:'packing',type:'other_expense',date:'2026-11-04',expensesCents:200,paymentStatus:'confirmed',verification:{type:'confirmed',date:'confirmed',expensesCents:'confirmed',paymentStatus:'confirmed'}},
    {externalId:'future-offer',type:'pending_offer',date:'2026-11-05',expectedCents:900,paymentStatus:'pending',verification:{type:'confirmed',date:'confirmed',expectedCents:'pending',paymentStatus:'pending'}},
  ];const metrics=getMetrics(applyMigration(blank,parsed(payload)));expect(metrics.netCashProceedsCents).toBe(3500);expect(metrics.purchaseInvestmentCents).toBe(7300);expect(metrics.overallCashPositionCents).toBe(-4000);expect(metrics.storeCreditBalanceCents).toBe(1200);expect(metrics.expectedFutureProceedsCents).toBe(900)
  })
  it('flags ambiguous title-and-lot matches rather than selecting one silently',()=>{const first=applyMigration(blank,parsed(basePayload()));const dupe={...first,items:[...first.items,{...first.items[0],id:'another-copy-record',externalId:'undefined'}]};const incoming=basePayload();incoming.inventoryItems[0].externalId='new-id';expect(previewMigration(dupe,parsed(incoming)).find((row)=>row.kind==='inventory_item')?.status).toBe('ambiguous')})
})
