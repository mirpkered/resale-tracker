import { describe, expect, it } from 'vitest'
import { getMetrics, type InventoryItem, type TrackerData } from './domain'
import { archiveEligibility, archiveInventoryItem, deleteInventoryItem, deletionEligibility, restoreInventoryItem, visibleInventoryItems } from './itemLifecycle'

const item:InventoryItem={id:'dvd-1',title:'Disposed DVD',category:'DVD',quantity:0,originalQuantity:1,lotId:'lot-1',costCents:100,askingCents:0,platform:'Vinted',status:'disposed',externalSource:'verified-import',externalId:'HAL26-DVD-017'}
const fixture=():TrackerData=>({
  lots:[{id:'lot-1',name:'Halloween DVD Haul',date:'2026-10-31',source:'Thrift store',purchaseCents:2300,expensesCents:0}],
  items:[item],units:[{id:'unit-1',itemId:item.id,copyNumber:1,status:'disposed'}],sales:[],expenses:[],credit:[],platforms:[],
})

describe('safe inventory archive and deletion',()=>{
  it('blocks archiving available inventory and items with active listings',()=>{
    expect(archiveEligibility({...item,status:'acquired',quantity:1}).allowed).toBe(false)
    expect(archiveEligibility({...item,status:'active',quantity:0}).reasons.join(' ')).toMatch(/active listing/)
  })

  it('allows a disposed item to be archived and restored without changing its records or financial totals',()=>{
    const data=fixture(),before=JSON.stringify(data),metrics=getMetrics(data)
    expect(archiveEligibility(item).allowed).toBe(true)
    const archived=archiveInventoryItem(data,item.id)
    expect(archived.items[0]).toMatchObject({id:item.id,archived:true,costCents:100,quantity:0,externalId:item.externalId})
    expect(archived.units).toEqual(data.units)
    expect(visibleInventoryItems(archived.items,false)).toEqual([])
    expect(visibleInventoryItems(archived.items,true)).toHaveLength(1)
    expect(getMetrics(archived)).toEqual(metrics)
    const restored=restoreInventoryItem(archived,item.id)
    expect(restored.items[0]).toMatchObject({id:item.id,archived:false,costCents:100,quantity:0})
    expect(visibleInventoryItems(restored.items,false)).toHaveLength(1)
    expect(restored.units).toEqual(data.units)
    expect(JSON.stringify(data)).toBe(before)
  })

  it('blocks deletion when quantity, cost allocations, units, sales, imports, listings, or ledger history depend on the item',()=>{
    const data=fixture()
    const result=deletionEligibility(data,item.id)
    expect(result.allowed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/acquisition cost/)
    expect(result.reasons.join(' ')).toMatch(/inventory units/)
    expect(result.reasons.join(' ')).toMatch(/import identity/)
    expect(()=>deleteInventoryItem(data,item.id)).toThrow()
    const dependent={...data,items:[{...item,quantity:0,originalQuantity:0,costCents:0,externalSource:undefined,externalId:undefined}],units:[],sales:[{id:'sale',date:'',platform:'Vinted',grossCents:100,feeCents:0,shippingCents:0,otherExpenseCents:0,paymentStatus:'paid' as const,receivedCents:100,refundCents:0,creditCents:0,itemIds:[item.id],status:'completed' as const}]}
    expect(deletionEligibility(dependent,item.id).reasons.join(' ')).toMatch(/Sale or bundle history/)
    const imported={...dependent,items:[{...dependent.items[0],externalId:'record-1',originalQuantity:0}],sales:[],ledgerTransactions:[{id:'buyback',externalSource:'migration',externalId:'batch-1',type:'buyback_payout' as const,date:'',platform:'Half Price Books',grossCents:100,feesCents:0,expensesCents:0,receivedCents:100,creditCents:0,expectedCents:0,paymentStatus:'confirmed' as const,itemExternalIds:['record-1'],fieldVerification:{receivedCents:'confirmed' as const}}]}
    expect(deletionEligibility(imported,item.id).reasons.join(' ')).toMatch(/payout, buyback, or other ledger record/)
  })

  it('permits permanent deletion only for an empty unlinked zero-cost erroneous record and leaves financial totals unchanged',()=>{
    const erroneous:InventoryItem={id:'bad-record',title:'Empty duplicate placeholder',category:'Other',quantity:0,originalQuantity:0,lotId:null,costCents:0,askingCents:0,platform:'Other',status:'acquired'}
    const data={...fixture(),items:[...fixture().items,erroneous]}
    expect(deletionEligibility(data,erroneous.id)).toEqual({allowed:true,reasons:[]})
    const before=getMetrics(data),deleted=deleteInventoryItem(data,erroneous.id)
    expect(deleted.items.map((entry)=>entry.id)).toEqual([item.id])
    expect(getMetrics(deleted)).toEqual(before)
    expect(data.items).toContain(erroneous)
  })
})
