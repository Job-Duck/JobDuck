import { syncConfig, syncOnce } from '../commands/sync'
import { DEFAULT_AUTO_SYNC_MINUTES, loadPermissions } from '../config/permissions'
import type { Db } from '../db/client'
import { permissionsPath } from '../paths'
import { type AutoSync, type AutoSyncOptions, type AutoSyncSettings, SyncBusyError, createAutoSync } from '../sync/auto'
import type { FetchLike } from '../sync/client'
import type { ApiResponse } from './api'

export const SYNC_PATH = '/api/sync'
export const SYNC_NOT_CONFIGURED = 'sync is not configured: turn on the track module and set the Email Sync URL and token in Settings'

export type DashboardSyncOverrides = Pick<AutoSyncOptions, 'setTimer' | 'clearTimer' | 'now' | 'firstDelayMs'> & { fetch?: FetchLike }

export interface DashboardSyncOptions extends DashboardSyncOverrides {
  db: Db
  home: string
  out: (line: string) => void
}

function intervalMinutes(home: string): number {
  try {
    return loadPermissions(permissionsPath(home)).track.auto_sync_minutes
  } catch {
    return DEFAULT_AUTO_SYNC_MINUTES
  }
}

export function autoSyncSettings(home: string): AutoSyncSettings {
  return { configured: syncConfig(home) !== null, intervalMinutes: intervalMinutes(home) }
}

/** The dashboard's auto-sync: the same fetch → store → ack as `jobduck sync`, into the dashboard's open database. */
export function createDashboardSync(options: DashboardSyncOptions): AutoSync {
  const { db, home, out, fetch, ...timers } = options
  return createAutoSync({
    ...timers,
    settings: () => autoSyncSettings(home),
    secret: () => syncConfig(home)?.token ?? '',
    log: out,
    run: async () => {
      const config = syncConfig(home)
      if (config === null) throw new Error(SYNC_NOT_CONFIGURED)
      const { totals, errors } = await syncOnce(db, config, { fetch })
      return { totals, errors }
    },
  })
}

/** `GET /api/sync` reports the timer and the last run; `POST /api/sync` runs one now. */
export async function handleSync(sync: AutoSync, method: string): Promise<ApiResponse> {
  if (method === 'GET') return { status: 200, body: sync.status() }
  if (method !== 'POST') return { status: 405, body: { error: 'method not allowed' } }
  if (!sync.status().configured) return { status: 400, body: { error: SYNC_NOT_CONFIGURED } }
  try {
    return { status: 200, body: await sync.runNow() }
  } catch (error) {
    if (error instanceof SyncBusyError) return { status: 409, body: { error: error.message } }
    throw error
  }
}
