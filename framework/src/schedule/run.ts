import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../db/client'
import { migrate } from '../db/migrate'
import {
  type ScheduleMode, type ScheduledRun, finishRun, lastSuccessfulRun, runCounts, startRun,
} from '../db/scheduled-runs'
import { hostById } from '../hosts'
import { dbPath } from '../paths'
import { readSchedule } from './settings'
import type { HostRunner } from './system'

export const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000
/** find's default `posted_within_days`, and the most a scheduled run looks back. */
export const MAX_WINDOW_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

/** Days since the last successful scheduled run, rounded up, at least 1 and at most MAX_WINDOW_DAYS. */
export function postedWithinDays(lastStartedAt: string | null, now: Date): number {
  if (lastStartedAt === null) return MAX_WINDOW_DAYS
  const days = Math.ceil((now.getTime() - new Date(lastStartedAt).getTime()) / DAY_MS)
  return Math.min(MAX_WINDOW_DAYS, Math.max(1, Number.isFinite(days) ? days : MAX_WINDOW_DAYS))
}

export const PROMPT_PREFIX = 'Job Duck scheduled run'

/** The fixed prompt for each mode. It names the mode so the find and apply skills recognise the unattended run. */
export function schedulePrompt(mode: ScheduleMode, lastStartedAt: string | null, now: Date): string {
  const days = postedWithinDays(lastStartedAt, now)
  const since = lastStartedAt === null ? 'no earlier scheduled run' : `the last scheduled run started ${lastStartedAt}`
  const window = `posted_within_days: ${days} (${since})`
  const unattended = 'Nobody is watching this run: never wait for input or ask a question.'
  if (mode === 'find_only') {
    return `${PROMPT_PREFIX}, mode: find_only. ${unattended} Run the find skill for postings since the last scheduled run, `
      + `with ${window}, and save the shortlist: record_application with status "saved" for each shortlisted posting `
      + 'that is not already tracked. Do not apply. End with the find skill\'s output.'
  }
  return `${PROMPT_PREFIX}, mode: apply. ${unattended} Run the apply skill as a scheduled unattended run, following its `
    + `Unattended rules; discover with the find skill using ${window}. End with the apply skill's report.`
}

const localDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

export const logPathFor = (home: string, date: Date) => join(home, 'logs', `schedule-${localDate(date)}.log`)

export interface ScheduleRunOptions {
  home: string
  workspace: string
  userHome?: string
  runHost: HostRunner
  timeoutMs?: number
  now?: () => Date
  env?: Record<string, string | undefined>
  out?: (line: string) => void
  err?: (line: string) => void
}

export type ScheduleRunOutcome =
  | { status: 'disabled'; exitCode: 0 }
  | { status: 'in_flight'; exitCode: 1; run: ScheduledRun }
  | { status: 'finished'; exitCode: number; run: ScheduledRun }

function openMigrated(home: string) {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const db = openDb(dbPath(home))
  try {
    migrate(db)
  } catch (error) {
    db.close()
    throw error
  }
  return db
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function failure(result: { exitCode: number | null; timedOut: boolean }, timeoutMs: number): string | null {
  if (result.timedOut) return `timed out after ${Math.round(timeoutMs / 60_000)} min and was stopped`
  if (result.exitCode === null) return 'the agent host was killed by a signal'
  if (result.exitCode !== 0) return `the agent host exited with code ${result.exitCode}`
  return null
}

/**
 * One scheduled run: record a scheduled_runs row (refusing while another run is in flight), start the configured host
 * headless in the workspace with the fixed prompt and a timeout, then store its exit code and the database changes
 * of the run window. Output goes to `<home>/logs/schedule-<date>.log`.
 */
export async function scheduledRun(options: ScheduleRunOptions): Promise<ScheduleRunOutcome> {
  const now = options.now ?? (() => new Date())
  const out = options.out ?? (() => undefined)
  const err = options.err ?? (() => undefined)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const settings = readSchedule(options.home, options.workspace, options.userHome)
  if (!settings.enabled) {
    out('Scheduled runs are off ([schedule] enabled = false); jobduck schedule install turns them on.')
    return { status: 'disabled', exitCode: 0 }
  }

  const startedAt = now()
  const logPath = logPathFor(options.home, startedAt)
  const log = (line: string) => {
    mkdirSync(join(options.home, 'logs'), { recursive: true, mode: 0o700 })
    appendFileSync(logPath, `[${now().toISOString()}] ${line}\n`, { mode: 0o600 })
  }

  let db = openMigrated(options.home)
  let run: ScheduledRun
  let lastStartedAt: string | null
  try {
    const started = startRun(db, { mode: settings.mode, host: settings.host, now: startedAt })
    if ('inFlight' in started) {
      const line = `Another scheduled run (#${started.inFlight.id}, started ${started.inFlight.started_at}) is still going; not starting a second one.`
      err(line)
      log(line)
      return { status: 'in_flight', exitCode: 1, run: started.inFlight }
    }
    run = started.started
    lastStartedAt = lastSuccessfulRun(db, run.started_at)?.started_at ?? null
  } finally {
    db.close()
  }

  const argv = hostById(settings.host).headless(schedulePrompt(settings.mode, lastStartedAt, startedAt))
  const intro = `scheduled run #${run.id}: mode ${settings.mode}, host ${settings.host}, in ${options.workspace}`
  out(intro)
  log(intro)
  log(`prompt: ${argv.at(-1)}`)

  let exitCode: number | null = null
  let error: string | null
  try {
    const result = await options.runHost(argv, {
      cwd: options.workspace,
      env: { ...(options.env ?? process.env), JOBDUCK_HOME: options.home },
      timeoutMs,
      logPath,
    })
    exitCode = result.exitCode
    error = failure(result, timeoutMs)
  } catch (spawnError) {
    error = `could not start ${argv[0]}: ${message(spawnError)}`
  }

  const finishedAt = now().toISOString()
  db = openMigrated(options.home)
  try {
    const counts = runCounts(db, run.started_at, finishedAt)
    run = finishRun(db, run.id, { finishedAt, exitCode, counts, error })
  } finally {
    db.close()
  }
  const summary = `scheduled run #${run.id} finished: found ${run.found}, applied ${run.applied}, pending ${run.pending}`
    + `${error ? `; ${error}` : ''}`
  if (error) err(summary)
  else out(summary)
  log(summary)
  return { status: 'finished', exitCode: exitCode === 0 && error === null ? 0 : 1, run }
}
