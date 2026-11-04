import type { TrackerData } from './domain'
import { DEMO_KEY, loadDemo } from './demo'

export const WORKSPACE_KEY = 'resale-tracker-workspace-v2'
export type WorkspaceMode = 'demo' | 'personal'
export interface SyncBatch { format: 'resale-tracker-sync-batch'; schemaVersion: '1.0'; batchId: string; baseRevision: number; createdAt: string; data: TrackerData }
export interface RemoteDocument { schemaVersion: '2.0'; revision: number; updatedAt: string; importedBatches: Array<{ batchId: string }>; data: TrackerData }
export interface LocalWorkspace { mode: WorkspaceMode; data: TrackerData; baseRevision: number; baseline: string; pendingBatch?: SyncBatch; remoteCandidate?: string; lastConfirmedAt?: string }
export const blankData = (): TrackerData => ({ lots: [], items: [], sales: [], expenses: [], credit: [], platforms: [] })
const serialize = (data: TrackerData) => JSON.stringify(data)

export function loadWorkspace(): LocalWorkspace {
  try {
    const saved = localStorage.getItem(WORKSPACE_KEY)
    if (saved) return JSON.parse(saved) as LocalWorkspace
  } catch { /* Invalid local metadata is ignored; prior demo data remains intact. */ }
  const data = loadDemo()
  return { mode: 'demo', data, baseRevision: 0, baseline: serialize(data) }
}
export function saveWorkspace(workspace: LocalWorkspace) { localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspace)) }
export function startPersonalWorkspace(): LocalWorkspace {
  const data = blankData()
  const workspace: LocalWorkspace = { mode: 'personal', data, baseRevision: 0, baseline: serialize(data) }
  saveWorkspace(workspace)
  return workspace
}
export function withLocalData(workspace: LocalWorkspace, data: TrackerData): LocalWorkspace {
  const next = { ...workspace, data }
  saveWorkspace(next)
  if (workspace.mode === 'demo') localStorage.setItem(DEMO_KEY, JSON.stringify(data))
  return next
}
export function isWorkspaceDirty(workspace: LocalWorkspace) { return workspace.mode === 'personal' && serialize(workspace.data) !== workspace.baseline }
export function exportPendingBatch(workspace: LocalWorkspace) {
  if (workspace.mode !== 'personal') throw new Error('Start a personal workspace before preparing a GitHub sync batch. Demo data cannot be synchronized.')
  const pendingBatch = workspace.pendingBatch && serialize(workspace.pendingBatch.data) === serialize(workspace.data) ? workspace.pendingBatch : { format: 'resale-tracker-sync-batch' as const, schemaVersion: '1.0' as const, batchId: crypto.randomUUID(), baseRevision: workspace.baseRevision, createdAt: new Date().toISOString(), data: workspace.data }
  const next = { ...workspace, pendingBatch }
  saveWorkspace(next)
  return { workspace: next, batch: pendingBatch }
}
export function receiveRemoteDocument(workspace: LocalWorkspace, text: string): { workspace: LocalWorkspace; conflict: boolean; acknowledged: boolean } {
  const remote = parseRemoteDocument(text)
  const dirty = isWorkspaceDirty(workspace)
  if ((dirty && (remote.revision !== workspace.baseRevision || serialize(remote.data) !== workspace.baseline)) || remote.revision < workspace.baseRevision) return { workspace: { ...workspace, remoteCandidate: text }, conflict: true, acknowledged: false }
  const acknowledged = Boolean(workspace.pendingBatch && remote.importedBatches.some((entry: { batchId: string }) => entry.batchId === workspace.pendingBatch?.batchId))
  const data = remote.data
  const next: LocalWorkspace = { mode: 'personal', data, baseRevision: remote.revision, baseline: serialize(data), lastConfirmedAt: remote.updatedAt, pendingBatch: undefined, remoteCandidate: undefined }
  saveWorkspace(next)
  return { workspace: next, conflict: false, acknowledged }
}
export function discardLocalAndLoadRemote(workspace: LocalWorkspace): LocalWorkspace {
  if (!workspace.remoteCandidate) throw new Error('There is no remote conflict document to load.')
  const remote = parseRemoteDocument(workspace.remoteCandidate)
  const data = remote.data
  const next: LocalWorkspace = { mode: 'personal', data, baseRevision: remote.revision, baseline: serialize(data), lastConfirmedAt: remote.updatedAt }
  saveWorkspace(next)
  return next
}

export function parseRemoteDocument(text: string): RemoteDocument {
  const remote = JSON.parse(text) as RemoteDocument
  if (remote?.schemaVersion !== '2.0' || !Number.isSafeInteger(remote.revision) || remote.revision < 0 || !remote.data || !Array.isArray(remote.importedBatches)) throw new Error('This is not a valid Resale Tracker v2 data document.')
  for (const key of ['lots', 'items', 'sales', 'expenses', 'credit', 'platforms'] as const) if (!Array.isArray(remote.data[key])) throw new Error(`Remote document is missing ${key}.`)
  const unique = (rows: Array<{id:string}>, label: string) => { const ids=new Set<string>(); for(const row of rows){if(!row.id||ids.has(row.id))throw new Error(`Remote document has a missing or duplicate ${label} ID.`);ids.add(row.id)}return ids }
  const lots=unique(remote.data.lots,'lot'),items=unique(remote.data.items,'item');unique(remote.data.sales,'sale');unique(remote.data.expenses,'expense');unique(remote.data.credit,'store credit');unique(remote.data.platforms,'platform')
  const cents=(value:number,label:string)=>{if(!Number.isSafeInteger(value)||value<0)throw new Error(`Remote document contains an invalid ${label} amount.`)}
  const allocated=new Map<string,number>()
  for (const lot of remote.data.lots) { cents(lot.purchaseCents,'lot');cents(lot.expensesCents,'lot');allocated.set(lot.id,0) }
  for (const item of remote.data.items) { cents(item.costCents,'item cost');cents(item.askingCents,'asking price');if(!Number.isSafeInteger(item.quantity)||item.quantity<0)throw new Error(`Remote item ${item.id} has invalid quantity.`);if(item.lotId){if(!lots.has(item.lotId))throw new Error(`Remote item ${item.id} references a missing lot.`);allocated.set(item.lotId,(allocated.get(item.lotId)??0)+item.costCents)} }
  for(const lot of remote.data.lots)if((allocated.get(lot.id)??0)>lot.purchaseCents+lot.expensesCents)throw new Error(`Remote item costs exceed lot ${lot.id}.`)
  for(const sale of remote.data.sales){for(const field of ['grossCents','feeCents','shippingCents','otherExpenseCents','receivedCents','refundCents','creditCents'] as const)cents(sale[field],`sale ${field}`);for(const line of sale.lines??[]){if(!items.has(line.itemId))throw new Error(`Remote sale ${sale.id} references a missing item.`);cents(line.allocatedCostCents,'allocated item cost');cents(line.proceedsCents??0,'allocated proceeds')}}
  for(const expense of remote.data.expenses)cents(expense.amountCents,'expense')
  for(const transaction of remote.data.credit)cents(transaction.amountCents,'store credit')
  return remote
}
