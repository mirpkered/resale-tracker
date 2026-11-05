import { beforeEach, describe, expect, it, vi } from 'vitest'
import { demoData, DEMO_KEY } from './demo'
import { discardLocalAndLoadRemote, exportLocalBackup, exportPendingBatch, isWorkspaceDirty, loadWorkspace, parseLocalBackup, receiveRemoteDocument, startPersonalWorkspace, withLocalData, WORKSPACE_KEY } from './storage'

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  clear() { this.values.clear() }
}
const memory = new MemoryStorage()
const uuid = '00000000-0000-4000-8000-000000000001'
const snapshot = (revision: number, data: ReturnType<typeof startPersonalWorkspace>['data'], importedBatches: Array<{batchId:string}> = []) => JSON.stringify({schemaVersion:'2.0',revision,updatedAt:'2026-11-04T01:00:00Z',lastBatchId:null,lastBatchHash:null,importedBatches,audit:[],data})

beforeEach(() => { memory.clear(); vi.stubGlobal('localStorage', memory); vi.stubGlobal('crypto', { randomUUID: () => uuid }) })

describe('browser storage adapter', () => {
  it('keeps demo data separate and creates empty personal data without migration', () => {
    memory.setItem(DEMO_KEY, JSON.stringify(demoData))
    const demo = loadWorkspace(); expect(demo.mode).toBe('demo'); expect(demo.data.items.length).toBeGreaterThan(0)
    const personal = startPersonalWorkspace(); expect(personal.data.items).toHaveLength(0); expect(personal.data.lots).toHaveLength(0); expect(memory.getItem(DEMO_KEY)).not.toBeNull()
    expect(() => exportLocalBackup(demo)).toThrow(/Demo data cannot be exported/)
  })
  it('round-trips a validated personal backup without importing it into the cloud automatically', () => {
    const personal = startPersonalWorkspace(), data = { ...personal.data, lots: [{ id: uuid, name: 'Private test lot', date: '2026-11-04', source: 'Test', purchaseCents: 100, expensesCents: 0 }] }, edited = withLocalData(personal, data)
    const backup = exportLocalBackup(edited, '2026-11-04T02:00:00.000Z'), restored = parseLocalBackup(JSON.stringify(backup))
    expect(restored.data.lots).toEqual(data.lots); expect(restored.exportedAt).toBe('2026-11-04T02:00:00.000Z'); expect(isWorkspaceDirty(edited)).toBe(true)
    expect(() => parseLocalBackup(JSON.stringify({ ...backup, data: { ...data, lots: [{ ...data.lots[0], purchaseCents: 0.5 }] } }))).toThrow(/invalid lot/)
  })
  it('marks edits local and repeats the exact batch on a retry', () => {
    const fresh = startPersonalWorkspace(); const edited = withLocalData(fresh, {...fresh.data,lots:[{id:uuid,name:'Lot',date:'2026-11-04',source:'Store',purchaseCents:1000,expensesCents:0}]})
    expect(isWorkspaceDirty(edited)).toBe(true)
    const a = exportPendingBatch(edited); const b = exportPendingBatch(a.workspace)
    expect(b.batch.batchId).toBe(a.batch.batchId); expect(JSON.stringify(b.batch)).toBe(JSON.stringify(a.batch))
  })
  it('detects newer remote revisions and only discards after explicit resolution', () => {
    const fresh = startPersonalWorkspace(); const local = withLocalData(fresh, {...fresh.data,expenses:[{id:uuid,date:'2026-11-04',amountCents:1,description:'Local'}]})
    const remote = snapshot(2,{...fresh.data,lots:[{id:'remote-lot',name:'remote',date:'2026-11-04',source:'',purchaseCents:0,expensesCents:0}]})
    const result = receiveRemoteDocument(local,remote)
    expect(result.conflict).toBe(true); expect(result.workspace.data.expenses).toHaveLength(1)
    const resolved = discardLocalAndLoadRemote(result.workspace)
    expect(resolved.baseRevision).toBe(2); expect(resolved.data.expenses).toHaveLength(0); expect(resolved.data.lots).toHaveLength(1)
  })
  it('recognizes confirmation only when imported-batch history includes the pending ID', () => {
    const local = exportPendingBatch(startPersonalWorkspace()).workspace
    const confirmed = receiveRemoteDocument(local,snapshot(1,local.data,[{batchId:local.pendingBatch!.batchId}]))
    expect(confirmed.acknowledged).toBe(true); expect(confirmed.workspace.lastConfirmedAt).toBe('2026-11-04T01:00:00Z'); expect(memory.getItem(WORKSPACE_KEY)).not.toBeNull()
  })
})
