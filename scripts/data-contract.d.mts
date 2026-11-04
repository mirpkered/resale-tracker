import type { TrackerData } from '../src/domain'
export const DOCUMENT_SCHEMA: '2.0'
export const BATCH_SCHEMA: '1.0'
export function stableJson(value: unknown): string
export function sha256(value: unknown): string
export function emptyData(): TrackerData
export function emptyDocument(now?: string): StoredDocument
export function validateData(data: TrackerData): TrackerData
export function validateDocument(document: StoredDocument): StoredDocument
export function makeBatch(data: TrackerData, baseRevision: number, batchId?: string, createdAt?: string): SyncBatch
export function applyBatch(current: StoredDocument, batch: SyncBatch, options?: { now?: string; actor?: string }): { document: StoredDocument; duplicate: boolean; hash: string }
export function restoreBackup(current: StoredDocument, backup: StoredDocument, options: { expectedRevision: number; now?: string; actor?: string }): StoredDocument
export function safeParseDocument(text: string): StoredDocument
export interface StoredDocument { schemaVersion: '2.0'; revision: number; updatedAt: string; lastBatchId: string | null; lastBatchHash: string | null; importedBatches: Array<{ batchId: string; sha256: string; appliedRevision: number; appliedAt: string }>; audit: Array<Record<string, unknown>>; data: TrackerData }
export interface SyncBatch { format: 'resale-tracker-sync-batch'; schemaVersion: '1.0'; batchId: string; baseRevision: number; createdAt: string; data: TrackerData }
