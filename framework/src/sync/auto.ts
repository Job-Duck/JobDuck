import type { SyncTotals } from '../commands/sync'
import { SyncAuthError } from './client'

/** Delay before the first automatic run after the dashboard starts. */
export const FIRST_RUN_DELAY_MS = 10_000
const MINUTE_MS = 60_000
/** setTimeout's largest delay; a longer one overflows and fires after 1 ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1

export interface AutoSyncSettings {
  /** True when the track module is on and `sync_url` and `sync_token` are set. */
  configured: boolean
  /** `[track] auto_sync_minutes`; 0 turns the timer off. */
  intervalMinutes: number
}

export interface SyncAttempt {
  totals: SyncTotals
  errors: string[]
  /** The token was rejected after the fetch (on ack); pauses the timer like a rejected fetch. */
  authRejected?: boolean
}

export interface LastSync {
  at: string
  ok: boolean
  error?: string
  totals?: SyncTotals
}

export interface AutoSyncStatus {
  configured: boolean
  enabled: boolean
  interval_minutes: number
  running: boolean
  last: LastSync | null
}

export type TimerHandle = unknown

export interface AutoSyncOptions {
  /** Read on every tick, so a Settings change applies without a restart. */
  settings: () => AutoSyncSettings
  run: () => Promise<SyncAttempt>
  log?: (line: string) => void
  /** The sync token; removed from every logged line and stored error. */
  secret?: () => string
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (timer: TimerHandle) => void
  now?: () => Date
  firstDelayMs?: number
}

export interface AutoSync {
  start(): void
  /** Re-reads the settings and reschedules (after a Settings save). */
  refresh(): void
  stop(): void
  /** Runs one sync now and resumes a timer an auth error paused. Throws SyncBusyError while one is running. */
  runNow(): Promise<AutoSyncStatus>
  status(): AutoSyncStatus
}

export class SyncBusyError extends Error {
  constructor() {
    super('a sync is already running')
    this.name = 'SyncBusyError'
  }
}

/** setTimeout that never keeps the process alive on its own. */
export function unrefTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return timer
}

const REDACTED = '[redacted]'

export function createAutoSync(options: AutoSyncOptions): AutoSync {
  const setTimer = options.setTimer ?? unrefTimer
  const clearTimer = options.clearTimer ?? ((timer: TimerHandle) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const now = options.now ?? (() => new Date())
  const firstDelayMs = options.firstDelayMs ?? FIRST_RUN_DELAY_MS

  let timer: TimerHandle | null = null
  let started = false
  let stopped = false
  let pausedByAuth = false
  let running = false
  let last: LastSync | null = null

  const log = (line: string) => {
    if (!stopped) options.log?.(redact(line))
  }

  function redact(text: string): string {
    const secret = options.secret?.() ?? ''
    return secret === '' ? text : text.split(secret).join(REDACTED)
  }

  const active = (settings: AutoSyncSettings) =>
    started && !stopped && !pausedByAuth && settings.configured && settings.intervalMinutes > 0

  function clear() {
    if (timer === null) return
    clearTimer(timer)
    timer = null
  }

  function schedule(ms: number) {
    clear()
    timer = setTimer(tick, Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_TIMER_MS) : MAX_TIMER_MS)
  }

  function pauseForAuth() {
    pausedByAuth = true
    clear()
    log('auto-sync paused until you press Sync now on the Applications tab')
  }

  function tick() {
    timer = null
    const settings = options.settings()
    if (!active(settings)) return
    schedule(settings.intervalMinutes * MINUTE_MS)
    if (!running) void attempt()
  }

  async function attempt(): Promise<void> {
    running = true
    try {
      const result = await options.run()
      const errors = result.errors.map(redact)
      last = { at: now().toISOString(), ok: errors.length === 0, totals: result.totals }
      if (errors.length > 0) last.error = errors.join('; ')
      for (const line of errors) log(`sync: ${line}`)
      if (result.authRejected) pauseForAuth()
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error))
      last = { at: now().toISOString(), ok: false, error: message }
      log(`sync failed: ${message}`)
      if (error instanceof SyncAuthError) pauseForAuth()
    } finally {
      running = false
    }
  }

  function status(): AutoSyncStatus {
    const settings = options.settings()
    return {
      configured: settings.configured, enabled: active(settings), interval_minutes: settings.intervalMinutes, running, last,
    }
  }

  return {
    start() {
      if (started) return
      started = true
      if (active(options.settings())) schedule(firstDelayMs)
    },
    refresh() {
      if (!started || stopped) return
      const settings = options.settings()
      if (!active(settings)) return clear()
      schedule(last === null ? firstDelayMs : settings.intervalMinutes * MINUTE_MS)
    },
    stop() {
      stopped = true
      clear()
    },
    async runNow() {
      if (running) throw new SyncBusyError()
      pausedByAuth = false
      await attempt()
      const settings = options.settings()
      if (timer === null && active(settings)) schedule(settings.intervalMinutes * MINUTE_MS)
      return status()
    },
    status,
  }
}
