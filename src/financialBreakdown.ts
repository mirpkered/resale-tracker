import { ACTIVE_STATUSES, getMetrics, isFieldConfirmed, lineNetProceedsCents, lotTotalCents, receivedCashCents, retainedCostCents, saleNetCents, type LedgerTransaction, type Sale, type TrackerData } from './domain'
import { summarizeLot } from './lotView'

export function acquisitionBreakdown(data: TrackerData) {
  const lots = data.lots.map((lot) => {
    const confirmedCents = (isFieldConfirmed(lot,'purchaseCents')?lot.purchaseCents:0)+(isFieldConfirmed(lot,'expensesCents')?lot.expensesCents:0)
    return { lot, confirmedCents, estimatedCents: lotTotalCents(lot)-confirmedCents, allocationsCents:data.items.filter((item)=>item.lotId===lot.id).reduce((sum,item)=>sum+item.costCents,0), acquisitions:lot.acquisitions??[] }
  })
  const standalone = data.items.filter((item)=>!item.lotId).map((item)=>({item,confirmedCents:isFieldConfirmed(item,'costCents')?item.costCents:0,estimatedCents:isFieldConfirmed(item,'costCents')?0:item.costCents}))
  return { lots, standalone, confirmedTotalCents: getMetrics(data).purchaseInvestmentCents, estimatedTotalCents:getMetrics(data).estimatedAcquisitionCostCents }
}

export interface CashReceivedRow { id:string; title:string; lotId?:string; lotName:string; date:string; grossCents:number; expensesCents:number; receivedCents:number; status:string; source:'sale'|'ledger' }
export function cashReceivedBreakdown(data: TrackerData): CashReceivedRow[] {
  const lots = new Map(data.lots.map((lot)=>[lot.id,lot.name]))
  const saleRows:CashReceivedRow[] = data.sales.filter((sale)=>isFieldConfirmed(sale,'receivedCents')&&receivedCashCents(sale)>0).map((sale:Sale)=>({ id:sale.id,title:sale.itemIds.map((id)=>data.items.find((item)=>item.id===id)?.title??'Item').join(', ')||sale.platform,lotId:sale.lines?.map((line)=>data.items.find((item)=>item.id===line.itemId)?.lotId).find(Boolean)??undefined,lotName:sale.lines?.map((line)=>{const lotId=data.items.find((item)=>item.id===line.itemId)?.lotId;return lotId?lots.get(lotId):undefined}).find(Boolean)??'Unassigned lot',date:sale.date,grossCents:sale.grossCents,expensesCents:sale.feeCents+sale.shippingCents+sale.otherExpenseCents+sale.refundCents,receivedCents:receivedCashCents(sale),status:sale.paymentStatus,source:'sale' }))
  const ledgerRows:CashReceivedRow[] = (data.ledgerTransactions??[]).filter((entry)=>['cash_sale','buyback_payout'].includes(entry.type)&&entry.paymentStatus==='confirmed'&&isFieldConfirmed(entry,'receivedCents')&&entry.receivedCents>0).map((entry:LedgerTransaction)=>({id:entry.id,title:entry.platform??entry.type.replaceAll('_',' '),lotId:entry.lotId,lotName:lots.get(entry.lotId??'')??'Unassigned lot',date:entry.date,grossCents:entry.grossCents,expensesCents:entry.feesCents+(entry.shippingCents??0)+entry.expensesCents,receivedCents:entry.receivedCents,status:'confirmed',source:'ledger'}))
  return [...saleRows,...ledgerRows].sort((a,b)=>b.date.localeCompare(a.date))
}

export interface PendingRow { id:string; title:string; lotId?:string; lotName:string; amountCents:number; status:string; detail:string; source:'sale'|'ledger' }
function ledgerExpected(entry:LedgerTransaction) { return entry.fieldVerification?.expectedCents==='unknown'?0:(entry.expectedCents||Math.max(0,entry.grossCents-entry.feesCents-(entry.shippingCents??0)-entry.expensesCents)) }
export function pendingProceedsBreakdown(data: TrackerData): PendingRow[] {
  const lots=new Map(data.lots.map((lot)=>[lot.id,lot.name]))
  const sales:PendingRow[]=data.sales.filter((sale)=>sale.paymentStatus==='unpaid'&&isFieldConfirmed(sale,'grossCents')).map((sale)=>({id:sale.id,title:sale.itemIds.map((id)=>data.items.find((item)=>item.id===id)?.title??'Item').join(', ')||sale.platform,lotName:sale.lines?.map((line)=>{const lotId=data.items.find((item)=>item.id===line.itemId)?.lotId;return lotId?lots.get(lotId):undefined}).find(Boolean)??'Unassigned lot',amountCents:Math.max(0,sale.grossCents-sale.feeCents-sale.shippingCents-sale.otherExpenseCents-sale.refundCents),status:'awaiting payment',detail:`${sale.platform} · expected net; not received cash`,source:'sale'}))
  const ledger:PendingRow[]=(data.ledgerTransactions??[]).filter((entry)=>entry.type==='pending_offer'||(['cash_sale','buyback_payout'].includes(entry.type)&&entry.paymentStatus!=='confirmed')).map((entry)=>({id:entry.id,title:entry.platform??entry.type.replaceAll('_',' '),lotId:entry.lotId,lotName:lots.get(entry.lotId??'')??'Unassigned lot',amountCents:ledgerExpected(entry),status:entry.paymentStatus==='pending'?'pending':'awaiting payment',detail:entry.notes??entry.type.replaceAll('_',' '),source:'ledger' as const})).filter((row)=>row.amountCents>0)
  return [...sales,...ledger].sort((a,b)=>a.title.localeCompare(b.title))
}

export interface ProfitRow { id:string; title:string; lotId?:string; lotName:string; proceedsCents:number; expenseCents:number; costCents:number; profitCents:number|null; note:string; complete:boolean }
export function realizedProfitBreakdown(data: TrackerData): ProfitRow[] {
  const rows:ProfitRow[]=[]
  for(const sale of data.sales.filter((entry)=>entry.status==='completed'&&entry.paymentStatus!=='unpaid'&&isFieldConfirmed(entry,'receivedCents'))){
    const lines=sale.lines??[]
    const allCostsConfirmed=lines.length?lines.every((line)=>isFieldConfirmed(data.items.find((item)=>item.id===line.itemId)??{},'costCents')):sale.itemIds.every((id)=>isFieldConfirmed(data.items.find((item)=>item.id===id)??{},'costCents'))
    const proceeds=lines.length?lines.reduce((sum,line)=>sum+lineNetProceedsCents(sale,line),0):saleNetCents(sale)
    const cost=lines.length?lines.reduce((sum,line)=>sum+retainedCostCents(line),0):sale.itemIds.reduce((sum,id)=>sum+(data.items.find((item)=>item.id===id)?.costCents??0),0)
    const itemIds=lines.map((line)=>line.itemId).concat(sale.itemIds),lotId=itemIds.map((id)=>data.items.find((item)=>item.id===id)?.lotId).find(Boolean)??undefined
    rows.push({id:sale.id,title:itemIds.map((id)=>data.items.find((item)=>item.id===id)?.title??'Item').join(', ')||sale.platform,lotId,lotName:data.lots.find((lot)=>lot.id===lotId)?.name??'Unassigned lot',proceedsCents:proceeds,expenseCents:sale.feeCents+sale.shippingCents+sale.otherExpenseCents+sale.refundCents,costCents:cost,profitCents:allCostsConfirmed?proceeds-cost:null,note:allCostsConfirmed?'Confirmed sale and allocated costs':'Cost basis is incomplete; excluded from confirmed realized profit',complete:allCostsConfirmed})
  }
  for(const entry of data.ledgerTransactions??[]){
    if(!['cash_sale','buyback_payout'].includes(entry.type)||entry.paymentStatus!=='confirmed'||!isFieldConfirmed(entry,'receivedCents')||!entry.saleAllocatedCostCents?.length||entry.saleAllocatedProceedsCents?.length!==entry.saleAllocatedCostCents.length)continue
    const verified=entry.saleCostVerified??[],proceeds=entry.saleAllocatedProceedsCents.reduce((sum,value,index)=>sum+(verified[index]?value:0),0),cost=entry.saleAllocatedCostCents.reduce((sum,value,index)=>sum+(verified[index]?value:0),0),complete=verified.length===entry.saleAllocatedCostCents.length&&verified.every(Boolean)
    rows.push({id:entry.id,title:entry.platform??entry.type.replaceAll('_',' '),lotId:entry.lotId,lotName:data.lots.find((lot)=>lot.id===entry.lotId)?.name??'Unassigned lot',proceedsCents:proceeds,expenseCents:entry.feesCents+(entry.shippingCents??0)+entry.expensesCents,costCents:cost,profitCents:proceeds-cost,note:complete?'Verified item-level allocation':'Partial verified shares are shown; unverified shares are excluded from the dashboard total',complete})
  }
  return rows
}

export function cashPositionBreakdown(data: TrackerData) {
  const lots=data.lots.map((lot)=>{
    const summary=summarizeLot(data,lot)
    const otherExpenses=(data.ledgerTransactions??[]).filter((entry)=>entry.type==='other_expense'&&entry.lotId===lot.id&&entry.paymentStatus==='confirmed'&&isFieldConfirmed(entry,'expensesCents')).reduce((sum,entry)=>sum+entry.expensesCents,0)
    return {lot,summary,otherExpensesCents:otherExpenses,confirmedPositionCents:summary.cashPositionCents-otherExpenses,provisionalPositionCents:summary.estimatedCashPositionCents-otherExpenses}
  })
  const metrics=getMetrics(data)
  const lotConfirmed=lots.reduce((sum,row)=>sum+row.confirmedPositionCents,0)
  return {lots,overallConfirmedCents:metrics.overallCashPositionCents,estimatedAcquisitionCents:metrics.estimatedAcquisitionCostCents,unassignedAdjustmentCents:metrics.overallCashPositionCents-lotConfirmed}
}

export function activeAskingItems(data:TrackerData) { return data.items.filter((item)=>item.status==='active'&&item.quantity>0&&isFieldConfirmed(item,'askingCents')&&ACTIVE_STATUSES.includes(item.status)) }
