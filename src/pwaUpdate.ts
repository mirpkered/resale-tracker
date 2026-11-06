import type { CloudSyncStatus } from './cloudSync'

export function canActivateAppUpdate(dirty: boolean, status: CloudSyncStatus): boolean {
  return !dirty && status !== 'saving' && status !== 'unsynced' && status !== 'conflict' && status !== 'needs_merge'
}
