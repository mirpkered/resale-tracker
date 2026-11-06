import type { CloudSyncStatus } from './cloudSync'

export function canActivateAppUpdate(dirty: boolean, status: CloudSyncStatus, unsubmittedEdits = false): boolean {
  return !dirty && !unsubmittedEdits && status !== 'saving' && status !== 'unsynced' && status !== 'conflict' && status !== 'needs_merge'
}
