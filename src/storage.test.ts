import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sampleFixture } from './test-fixtures'
import { adoptRemoteDocument, discardLocalAndLoadRemote, exportLocalBackup, exportPendingBatch, isWorkspaceDirty, loadWorkspace, parseLocalBackup, preserveLocalRecoveryBackup, RECOVERY_BACKUP_KEY, receiveRemoteDocument, createEmptyWorkspace, withLocalData, WORKSPACE_KEY, blankData } from './storage'
import { getMetrics } from './domain'
import type { ItemStatus } from './domain'

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  clear() { this.values.clear() }
}
const memory = new MemoryStorage()
const uuid = '00000000-0000-4000-8000-000000000001'
const snapshot = (revision: number, data: ReturnType<typeof createEmptyWorkspace>['data'], importedBatches: Array<{batchId:string}> = []) => JSON.stringify({schemaVersion:'2.0',revision,updatedAt:'2026-11-04T01:00:00Z',lastBatchId:null,lastBatchHash:null,importedBatches,audit:[],data})

beforeEach(() => { memory.clear(); vi.stubGlobal('localStorage', memory); vi.stubGlobal('crypto', { randomUUID: () => uuid }) })

describe('browser storage adapter', () => {
  it('starts with empty personal data and never loads legacy sample records', () => {
    memory.setItem(WORKSPACE_KEY, JSON.stringify({ mode: 'demo', data: sampleFixture, baseRevision: 0, baseline: JSON.stringify(sampleFixture) }))
    const workspace = loadWorkspace()
    expect(workspace.data.items).toHaveLength(0); expect(workspace.data.lots).toHaveLength(0); expect(workspace.data.sales).toHaveLength(0)
    expect(JSON.parse(memory.getItem(WORKSPACE_KEY)!).data.items).toHaveLength(0)
    expect(exportLocalBackup(workspace).data.items).toHaveLength(0)
  })
  it('does not treat a fresh empty workspace as an unsaved cloud write', () => {
    const empty = createEmptyWorkspace()
    expect(isWorkspaceDirty(empty)).toBe(false)
    expect(empty.data).toEqual(blankData())
  })
  it('preserves old local records when their revision baseline is missing and creates a recoverable backup', () => {
    const data = { ...blankData(), lots: [{ id: 'old-local-lot', name: 'Old local lot', date: '2026-11-04', source: 'Local store', purchaseCents: 1234, expensesCents: 0 }] }
    memory.setItem(WORKSPACE_KEY, JSON.stringify({ data, baseRevision: 3 }))
    const workspace = loadWorkspace()
    expect(workspace.data.lots).toEqual(data.lots)
    expect(workspace.recoveryRequired).toBe(true)
    expect(isWorkspaceDirty(workspace)).toBe(true)
    const backup = preserveLocalRecoveryBackup(workspace, 'test recovery')
    expect(backup.workspace.data.lots).toEqual(data.lots)
    expect(JSON.parse(memory.getItem(RECOVERY_BACKUP_KEY)!)[0].format).toBe('resale-tracker-recovery-backup')
    const adopted = adoptRemoteDocument(snapshot(4, blankData()))
    expect(adopted.baseRevision).toBe(4)
    expect(isWorkspaceDirty(adopted)).toBe(false)
    expect(JSON.parse(memory.getItem(RECOVERY_BACKUP_KEY)!)[0].workspace.data.lots).toEqual(data.lots)
  })
  it('round-trips a validated personal backup without importing it into the cloud automatically', () => {
    const personal = createEmptyWorkspace(), data = { ...personal.data, lots: [{ id: uuid, name: 'Private test lot', date: '2026-11-04', source: 'Test', purchaseCents: 100, expensesCents: 0 }] }, edited = withLocalData(personal, data)
    const backup = exportLocalBackup(edited, '2026-11-04T02:00:00.000Z'), restored = parseLocalBackup(JSON.stringify(backup))
    expect(restored.data.lots).toEqual(data.lots); expect(restored.exportedAt).toBe('2026-11-04T02:00:00.000Z'); expect(isWorkspaceDirty(edited)).toBe(true)
    expect(() => parseLocalBackup(JSON.stringify({ ...backup, data: { ...data, lots: [{ ...data.lots[0], purchaseCents: 0.5 }] } }))).toThrow(/invalid lot/)
  })
  it('marks edits local and repeats the exact batch on a retry', () => {
    const fresh = createEmptyWorkspace(); const edited = withLocalData(fresh, {...fresh.data,lots:[{id:uuid,name:'Lot',date:'2026-11-04',source:'Store',purchaseCents:1000,expensesCents:0}]})
    expect(isWorkspaceDirty(edited)).toBe(true)
    const a = exportPendingBatch(edited); const b = exportPendingBatch(a.workspace)
    expect(b.batch.batchId).toBe(a.batch.batchId); expect(JSON.stringify(b.batch)).toBe(JSON.stringify(a.batch))
  })
  it('detects newer remote revisions and only discards after explicit resolution', () => {
    const fresh = createEmptyWorkspace(); const local = withLocalData(fresh, {...fresh.data,expenses:[{id:uuid,date:'2026-11-04',amountCents:1,description:'Local'}]})
    const remote = snapshot(2,{...fresh.data,lots:[{id:'remote-lot',name:'remote',date:'2026-11-04',source:'',purchaseCents:0,expensesCents:0}]})
    const result = receiveRemoteDocument(local,remote)
    expect(result.conflict).toBe(true); expect(result.workspace.data.expenses).toHaveLength(1)
    const resolved = discardLocalAndLoadRemote(result.workspace)
    expect(resolved.baseRevision).toBe(2); expect(resolved.data.expenses).toHaveLength(0); expect(resolved.data.lots).toHaveLength(1)
  })
  it('recognizes confirmation only when imported-batch history includes the pending ID', () => {
    const local = exportPendingBatch(createEmptyWorkspace()).workspace
    const confirmed = receiveRemoteDocument(local,snapshot(1,local.data,[{batchId:local.pendingBatch!.batchId}]))
    expect(confirmed.acknowledged).toBe(true); expect(confirmed.workspace.lastConfirmedAt).toBe('2026-11-04T01:00:00Z'); expect(memory.getItem(WORKSPACE_KEY)).not.toBeNull()
  })
  it('restores an existing cloud snapshot locally without changing its inventory or Halloween totals', () => {
    const items = Array.from({ length: 23 }, (_, index) => ({ id: `dvd-${index + 1}`, title: `DVD season set ${index + 1}`, category: 'DVD', quantity: index < 4 ? 0 : 1, originalQuantity: 1, lotId: 'halloween', costCents: 100, askingCents: 0, platform: 'Other', status: (index < 4 ? 'disposed' : 'acquired') as ItemStatus }))
    const units = items.map((item, index) => ({ id: `unit-${index + 1}`, itemId: item.id, copyNumber: 1, status: item.status }))
    const data = { ...blankData(), lots: [{ id: 'halloween', name: 'Halloween DVD Haul', date: '2026-10-31', source: 'Thrift store', purchaseCents: 2300, expensesCents: 0 }], items, units }
    const restored = receiveRemoteDocument(createEmptyWorkspace(), snapshot(3, data))
    expect(restored.conflict).toBe(false); expect(restored.workspace.baseRevision).toBe(3)
    expect(restored.workspace.data.items).toHaveLength(23); expect(restored.workspace.data.units).toHaveLength(23)
    expect(restored.workspace.data.items.filter((item) => item.status === 'disposed')).toHaveLength(4)
    expect(getMetrics(restored.workspace.data).purchaseInvestmentCents).toBe(2300)
    expect(getMetrics(restored.workspace.data).netCashProceedsCents).toBe(0)
    expect(getMetrics(restored.workspace.data).overallCashPositionCents).toBe(-2300)
  })
})
