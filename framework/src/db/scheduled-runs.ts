import { type Db, one, transaction } from './client'

export const SCHEDULE_MODES = ['find_only', 'apply'] as const
export type ScheduleMode = (typeof SCHEDULE_MODES)[number]

/** A run with no finished_at younger than this is still in flight; an older one was abandoned. */
export const IN_FLIGHT_MS = 2 * 60 * 60 * 1000

export interface ScheduledRun {
  id: number
  started_at: string
  finished_at: string | null
  mode: ScheduleMode
  host: string
  exit_code: number | null
  found: number | null
  applied: number | null
  pending: number | null
  error: string | null
}

export interface RunCounts {
  found: number
  applied: number
  pending: number
}

export interface FinishInput {
  finishedAt: string
  exitCode: number | null
  counts: RunCounts | null
  error: string | null
}

export const ABANDONED_ERROR = 'did not finish within 2 hours; marked abandoned'

export type StartResult = { started: ScheduledRun } | { inFlight: ScheduledRun }

/**
 * Starts a run unless another one is in flight (unfinished and started less than IN_FLIGHT_MS ago). Older unfinished
 * runs are closed as abandoned first, so a crashed run never blocks the next day.
 */
export function startRun(db: Db, input: { mode: ScheduleMode; host: string; now: Date }): StartResult {
  const startedAt = input.now.toISOString()
  const cutoff = new Date(input.now.getTime() - IN_FLIGHT_MS).toISOString()
  return transaction(db, () => {
    const running = one<ScheduledRun>(db.prepare(`SELECT * FROM scheduled_runs
        WHERE finished_at IS NULL AND started_at > ? ORDER BY started_at DESC, id DESC LIMIT 1`), cutoff)
    if (running) return { inFlight: running }
    db.prepare(`UPDATE scheduled_runs SET finished_at = ?, error = COALESCE(error, ?)
        WHERE finished_at IS NULL AND started_at <= ?`).run(startedAt, ABANDONED_ERROR, cutoff)
    const started = one<ScheduledRun>(db.prepare(`INSERT INTO scheduled_runs (started_at, mode, host)
        VALUES (?, ?, ?) RETURNING *`), startedAt, input.mode, input.host)
    if (!started) throw new Error('startRun returned no row')
    return { started }
  })
}

export function finishRun(db: Db, id: number, input: FinishInput): ScheduledRun {
  const row = one<ScheduledRun>(db.prepare(`UPDATE scheduled_runs
      SET finished_at = ?, exit_code = ?, found = ?, applied = ?, pending = ?, error = ?
      WHERE id = ? RETURNING *`),
    input.finishedAt, input.exitCode, input.counts?.found ?? null, input.counts?.applied ?? null,
    input.counts?.pending ?? null, input.error, id)
  if (!row) throw new Error(`scheduled run ${id} not found`)
  return row
}

export function lastRun(db: Db): ScheduledRun | undefined {
  return one<ScheduledRun>(db.prepare('SELECT * FROM scheduled_runs ORDER BY started_at DESC, id DESC LIMIT 1'))
}

/** The latest run that finished with exit code 0 before `before`: the start of the window a new find run searches. */
export function lastSuccessfulRun(db: Db, before?: string): ScheduledRun | undefined {
  return one<ScheduledRun>(db.prepare(`SELECT * FROM scheduled_runs
      WHERE exit_code = 0 AND (? IS NULL OR started_at < ?) ORDER BY started_at DESC, id DESC LIMIT 1`),
  before ?? null, before ?? null)
}

const count = (db: Db, sql: string, from: string, to: string) =>
  Number(one<{ n: number }>(db.prepare(sql), from, to)?.n ?? 0)

/**
 * What changed in the database between `from` and `to`: applications created (the saved shortlist), applications
 * moved to applied, and applications moved to pending.
 */
export function runCounts(db: Db, from: string, to: string): RunCounts {
  const moved = (status: string) => count(db, `SELECT COUNT(DISTINCT application_id) AS n FROM application_events
      WHERE to_status = '${status}' AND kind IS NULL AND created_at >= ? AND created_at <= ?`, from, to)
  return {
    found: count(db, 'SELECT COUNT(*) AS n FROM applications WHERE created_at >= ? AND created_at <= ?', from, to),
    applied: moved('applied'),
    pending: moved('pending'),
  }
}
