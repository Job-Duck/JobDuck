import { stamp } from './format'
import type { SyncStatus, SyncTotals } from './types'

export const SYNC_PATH = '/api/sync'

/** Emails stored by a run: matched, waiting to be confirmed, or waiting for a match. */
export const newCount = (totals: SyncTotals) => totals.matched.total + totals.awaiting_confirm + totals.needs_match

export function syncLine(status: SyncStatus): string {
  if (status.running) return 'Syncing mail outcomes…'
  const { last } = status
  if (last === null) return status.enabled ? 'Not synced yet; the first sync runs shortly.' : 'Not synced yet.'
  if (!last.ok) return `Sync failed ${stamp(last.at)}: ${last.error ?? 'unknown error'}`
  return `Last synced ${stamp(last.at)} · ${last.totals ? newCount(last.totals) : 0} new`
}

export const scheduleLabel = (status: SyncStatus) =>
  status.enabled ? `Auto-sync every ${status.interval_minutes} min` : 'Auto-sync off'
