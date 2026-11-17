import { existsSync } from 'node:fs'
import { loadPermissions } from '../config/permissions'
import { getApplication, isTerminal } from '../db/applications'
import { type Db, nowIso, openDb, transaction } from '../db/client'
import { migrate } from '../db/migrate'
import {
  type LiveApplication, type OutcomeKind, applyOutcomeMatch, findOutcomeByMessageId, insertOutcome, isSignalKind,
  listLiveApplicationsForMatching, markSynced, setNeedsMatch,
} from '../db/outcomes'
import { NoHomeError, dbPath, discoverHome, permissionsPath, resolveWorkspace } from '../paths'
import {
  type FetchLike, type InvalidOutcome, SyncAuthError, type SyncClient, type SyncOutcome, createSyncClient,
} from '../sync/client'
import { type MatchDecision, type MatchKind, type ScoredCandidate, markerId, matchOutcome as decideMatch } from '../sync/match'

export interface SyncOptions {
  dryRun?: boolean
  json?: boolean
  home?: string
  workspace?: string
  fetch?: FetchLike
  out?: (line: string) => void
  err?: (line: string) => void
}

export type SyncResultKind = 'matched' | 'awaiting_confirm' | 'needs_match' | 'known' | 'failed'

export interface SyncRow {
  messageId: string
  receivedAt: string
  company: string | null
  title: string | null
  kind: OutcomeKind
  scheduledAt?: string
  result: SyncResultKind
  matchedBy?: MatchKind
  applicationId?: number
  candidates?: ScoredCandidate[]
  error?: string
}

export interface SyncTotals {
  fetched: number
  matched: Record<MatchKind, number> & { total: number }
  awaiting_confirm: number
  needs_match: number
  known: number
  failed: number
}

const MATCH_KINDS: MatchKind[] = ['marker', 'url', 'ref', 'company_title']
const SETUP_HINT = 'jobduck sync is not configured: turn on the track module and set [track] sync_url and sync_token '
  + '(ask your agent to run the setup skill with --module track).'

export interface SyncConfig {
  url: string
  token: string
  autoApply: boolean
}

/** The `[track]` sync settings, or null when the track module is off or `sync_url` / `sync_token` is empty. */
export function syncConfig(home: string): SyncConfig | null {
  try {
    const permissions = loadPermissions(permissionsPath(home))
    const { sync_url: url, sync_token: token, auto_apply_interview_signals: autoApply } = permissions.track
    if (!permissions.modules.track || !url.trim() || !token.trim()) return null
    return { url: url.trim(), token: token.trim(), autoApply }
  } catch {
    return null
  }
}

const kindOf = (outcome: SyncOutcome): OutcomeKind => outcome.kind ?? 'rejection'

function baseRow(outcome: SyncOutcome): Omit<SyncRow, 'result'> {
  const base = {
    messageId: outcome.messageId, receivedAt: outcome.receivedAt, company: outcome.company ?? null,
    title: outcome.title ?? null, kind: kindOf(outcome),
  }
  return outcome.scheduledAt ? { ...base, scheduledAt: outcome.scheduledAt } : base
}

const invalidRow = (entry: InvalidOutcome): SyncRow => ({
  messageId: entry.messageId, receivedAt: entry.receivedAt, company: null, title: null, kind: 'rejection',
  result: 'failed', error: entry.error,
})

function decide(db: Db | null, outcome: SyncOutcome, live: LiveApplication[]): MatchDecision {
  const marker = markerId(outcome.applicationId)
  const markerApp = db !== null && marker !== null ? getApplication(db, marker) : undefined
  if (markerApp && isTerminal(markerApp.status)) return { kind: 'marker', applicationId: markerApp.id }
  return decideMatch(outcome, live)
}

function rowFor(outcome: SyncOutcome, decision: MatchDecision, autoApply: boolean): SyncRow {
  const base = baseRow(outcome)
  if (decision.kind === 'none') return { ...base, result: 'needs_match', candidates: decision.candidates }
  const result = isSignalKind(base.kind) && !autoApply ? 'awaiting_confirm' : 'matched'
  return { ...base, result, matchedBy: decision.kind, applicationId: decision.applicationId }
}

function store(db: Db, outcome: SyncOutcome, autoApply: boolean): { row: SyncRow; outcomeId: number } {
  return transaction(db, () => {
    const existing = findOutcomeByMessageId(db, outcome.messageId)
    if (existing) return { outcomeId: existing.id, row: { ...baseRow(outcome), result: 'known' as const } }
    const marker = markerId(outcome.applicationId)
    const markerApp = marker === null ? undefined : getApplication(db, marker)
    const stored = insertOutcome(db, {
      message_id: outcome.messageId, kind: kindOf(outcome), status: 'pending',
      company: outcome.company ?? null, title: outcome.title ?? null,
      job_url: outcome.jobUrl ?? null, job_ref: outcome.jobRef ?? null,
      received_at: outcome.receivedAt, application_id: markerApp?.id ?? null,
      scheduled_at: outcome.scheduledAt ?? null,
    })
    const decision = decide(db, outcome, listLiveApplicationsForMatching(db))
    if (decision.kind === 'none') setNeedsMatch(db, stored.id, decision.candidates)
    else {
      applyOutcomeMatch(db, stored.id, decision.applicationId, { source: 'sync', matchedBy: decision.kind, autoConfirm: autoApply })
    }
    return { outcomeId: stored.id, row: rowFor(outcome, decision, autoApply) }
  })
}

function plan(db: Db | null, outcomes: SyncOutcome[], autoApply: boolean): SyncRow[] {
  let live = db === null ? [] : listLiveApplicationsForMatching(db)
  return outcomes.map((outcome) => {
    if (db !== null && findOutcomeByMessageId(db, outcome.messageId)) return { ...baseRow(outcome), result: 'known' }
    const decision = decide(db, outcome, live)
    if (decision.kind !== 'none' && kindOf(outcome) === 'rejection') {
      live = live.filter((candidate) => candidate.id !== decision.applicationId)
    }
    return rowFor(outcome, decision, autoApply)
  })
}

export function totalsOf(rows: SyncRow[]): SyncTotals {
  const matched = Object.fromEntries(MATCH_KINDS.map((kind) => [kind, 0])) as Record<MatchKind, number>
  for (const row of rows) if (row.result === 'matched' && row.matchedBy) matched[row.matchedBy]++
  const count = (result: SyncResultKind) => rows.filter((row) => row.result === result).length
  return {
    fetched: rows.length,
    matched: { total: count('matched'), ...matched },
    awaiting_confirm: count('awaiting_confirm'),
    needs_match: count('needs_match'),
    known: count('known'),
    failed: count('failed'),
  }
}

function describe(row: SyncRow, dryRun: boolean): string {
  if (row.result === 'known') return 'already stored'
  if (row.result === 'failed') return `failed: ${row.error}`
  const kind = row.kind === 'rejection' ? '' : `${row.kind}: `
  if (row.result === 'matched') return `${kind}${dryRun ? 'would match' : 'matched'} #${row.applicationId} (${row.matchedBy})`
  if (row.result === 'awaiting_confirm') {
    return `${kind}${dryRun ? 'would await confirm on' : 'awaiting confirm on'} #${row.applicationId} (${row.matchedBy})`
  }
  const ids = (row.candidates ?? []).map((candidate) => `#${candidate.application_id}`).join(', ')
  return `${kind}${dryRun ? 'would need a match' : 'needs a match'}${ids ? ` (candidates ${ids})` : ''}`
}

function printTable(rows: SyncRow[], totals: SyncTotals, dryRun: boolean, out: (line: string) => void) {
  const table = rows.map((row) => [row.receivedAt.slice(0, 10), row.company ?? '?', row.title ?? '', describe(row, dryRun)])
  const widths = [0, 1, 2].map((i) => Math.min(40, Math.max(0, ...table.map((cells) => cells[i]!.length))))
  const cell = (value: string, width: number) => (value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width))
  for (const cells of table) out(`${cells.slice(0, 3).map((value, i) => cell(value, widths[i]!)).join('  ')}  ${cells[3]}`)
  const kinds = MATCH_KINDS.map((kind) => `${kind} ${totals.matched[kind]}`).join(', ')
  const failed = totals.failed > 0 ? ` / failed ${totals.failed}` : ''
  out(`fetched ${totals.fetched} / matched ${totals.matched.total} (${kinds}) / needs_match ${totals.needs_match} / known ${totals.known}`
    + ` / awaiting_confirm ${totals.awaiting_confirm}${failed}`)
}

function openForPlan(home: string): Db | null {
  const path = dbPath(home)
  return existsSync(path) ? openDb(path, { readonly: true }) : null
}

function openForStore(home: string): Db {
  const db = openDb(dbPath(home))
  try {
    migrate(db)
  } catch (error) {
    db.close()
    throw error
  }
  return db
}

/** An open database the caller keeps (the dashboard), or an opener whose database syncOnce closes when done (the CLI). */
export type SyncTarget = Db | (() => Db | null)

export interface SyncOnceOptions {
  dryRun?: boolean
  fetch?: FetchLike
  /** Called with each problem line as it happens; the same lines end up in `errors`. */
  err?: (line: string) => void
}

export interface SyncRun {
  dryRun: boolean
  scriptVersion: string
  rows: SyncRow[]
  totals: SyncTotals
  acked: number
  errors: string[]
  /** The ack was refused as unauthorized; a refused fetch throws SyncAuthError instead. */
  authRejected: boolean
}

async function storeAndAck(db: Db, client: SyncClient, outcomes: SyncOutcome[], autoApply: boolean, fail: (line: string) => void) {
  const rows: SyncRow[] = []
  const stored: { messageId: string; outcomeId: number }[] = []
  for (const outcome of outcomes) {
    try {
      const result = store(db, outcome, autoApply)
      rows.push(result.row)
      stored.push({ messageId: outcome.messageId, outcomeId: result.outcomeId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      rows.push({ ...baseRow(outcome), result: 'failed', error: message })
      fail(`could not store outcome ${outcome.messageId}: ${message}`)
    }
  }
  let acked = 0
  let authRejected = false
  if (stored.length > 0) {
    try {
      acked = await client.ack(stored.map((entry) => entry.messageId))
      markSynced(db, stored.map((entry) => entry.outcomeId), nowIso())
    } catch (error) {
      authRejected = error instanceof SyncAuthError
      fail(error instanceof Error ? error.message : String(error))
    }
  }
  return { rows, acked, authRejected }
}

/**
 * One sync: fetch the queued outcomes, store and match each (only plan them with dryRun), then acknowledge the stored
 * ones. Throws when the fetch fails (SyncAuthError for a rejected token); read, store and ack problems come back in
 * `errors`. Shared by `jobduck sync` and the dashboard's auto-sync.
 */
export async function syncOnce(target: SyncTarget, config: SyncConfig, options: SyncOnceOptions = {}): Promise<SyncRun> {
  const dryRun = options.dryRun ?? false
  const errors: string[] = []
  const fail = (line: string) => {
    errors.push(line)
    options.err?.(line)
  }
  const client = createSyncClient({ url: config.url, token: config.token, fetch: options.fetch })
  const { scriptVersion, outcomes, invalid } = await client.pending()
  for (const entry of invalid) fail(`could not read outcome ${entry.messageId || '(no messageId)'}: ${entry.error}`)

  const owned = typeof target === 'function'
  const db = owned ? target() : target
  let rows: SyncRow[]
  let acked = 0
  let authRejected = false
  try {
    if (dryRun) rows = plan(db, outcomes, config.autoApply)
    else if (db === null) throw new Error('sync needs a database to store outcomes in')
    else ({ rows, acked, authRejected } = await storeAndAck(db, client, outcomes, config.autoApply, fail))
  } finally {
    if (owned) db?.close()
  }

  rows.push(...invalid.map(invalidRow))
  return { dryRun, scriptVersion, rows, totals: totalsOf(rows), acked, errors, authRejected }
}

export async function runSync(options: SyncOptions = {}): Promise<number> {
  const out = options.out ?? ((line: string) => console.log(line))
  const err = options.err ?? ((line: string) => console.error(line))
  const workspace = resolveWorkspace(options.workspace ?? process.cwd())
  const home = options.home ?? discoverHome(workspace)
  if (home === undefined) {
    err(new NoHomeError(workspace).message)
    return 1
  }
  const dryRun = options.dryRun ?? false

  const config = syncConfig(home)
  if (config === null) {
    err(SETUP_HINT)
    return 2
  }

  let run: SyncRun
  try {
    run = await syncOnce(() => (dryRun ? openForPlan(home) : openForStore(home)), config, { dryRun, fetch: options.fetch, err })
  } catch (error) {
    err(error instanceof Error ? error.message : String(error))
    return 1
  }

  const { scriptVersion, rows, totals, acked } = run
  if (options.json) {
    out(JSON.stringify({ dryRun, scriptVersion, outcomes: rows, totals, acked }, null, 2))
  } else {
    if (dryRun) out('Dry run: nothing stored or acknowledged.')
    printTable(rows, totals, dryRun, out)
  }
  return run.errors.length > 0 ? 1 : 0
}
