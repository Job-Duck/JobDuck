import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { type Sandbox, migratedDb, sandbox } from './helpers'
import { handleApi } from '../src/dashboard/api'
import type { Db } from '../src/db/client'
import {
  type ApplicationStatus, createApplication, getApplication, listEvents, softDeleteApplication,
} from '../src/db/applications'
import { listStages } from '../src/db/interviews'
import {
  type OutcomeKind, confirmOutcome, dismissOutcome, getOutcome, insertOutcome, listLiveApplicationsForMatching, listOutcomes,
  markSynced, matchOutcome, setNeedsMatch,
} from '../src/db/outcomes'
import { upsertPosting } from '../src/db/postings'
import { permissionsPath } from '../src/paths'

let box: Sandbox
let db: Db
beforeEach(() => {
  box = sandbox()
  db = migratedDb(box.home)
})
afterEach(() => {
  db.close()
  box.cleanup()
})

const application = (status: ApplicationStatus = 'applied') => {
  const posting = upsertPosting(db, { source: 'manual', url: `https://acme.com/jobs/${status}`, title: 'AI Engineer', company: 'Acme' })
  return createApplication(db, { postingId: posting.id, status })
}

const rejection = (messageId = 'msg-1') => insertOutcome(db, {
  message_id: messageId, kind: 'rejection', company: 'Acme', title: 'AI Engineer',
  received_at: '2026-10-01T12:00:00.000Z', status: 'needs_match', candidates: [{ id: 1 }],
})

test('insertOutcome is idempotent on message_id', () => {
  const first = rejection()
  const again = insertOutcome(db, { message_id: 'msg-1', kind: 'rejection', received_at: '2026-10-02T00:00:00.000Z', status: 'pending' })
  expect(again.id).toBe(first.id)
  expect(again.status).toBe('needs_match')
  expect(again.received_at).toBe('2026-10-01T12:00:00.000Z')
  expect(JSON.parse(first.candidates ?? 'null')).toEqual([{ id: 1 }])
  expect(listOutcomes(db)).toHaveLength(1)
  rejection('msg-2')
  expect(listOutcomes(db, { status: 'needs_match' })).toHaveLength(2)
  expect(listOutcomes(db, { status: 'matched' })).toHaveLength(0)
})

test('matchOutcome closes the application as deny_by_employer with a dashboard event', () => {
  const app = application()
  const outcome = rejection()
  const result = matchOutcome(db, outcome.id, app.id, { source: 'dashboard' })
  expect(result.outcome).toMatchObject({ status: 'matched', matched_by: 'dashboard', application_id: app.id })
  expect(result.application.status).toBe('deny_by_employer')
  expect(getApplication(db, app.id)?.closed_at).not.toBeNull()
  const last = listEvents(db, app.id).at(-1)!
  expect(last).toMatchObject({
    from_status: 'applied', to_status: 'deny_by_employer', source: 'dashboard',
    note: 'Rejection email 2026-10-01T12:00:00.000Z',
  })
  expect(JSON.parse(last.metadata ?? '{}')).toEqual({ outcome_id: outcome.id })
  expect(listOutcomes(db, { status: 'needs_match' })).toHaveLength(0)
})

test('matchOutcome leaves terminal applications untouched', () => {
  const app = application('accepted')
  const outcome = rejection()
  const result = matchOutcome(db, outcome.id, app.id, { source: 'dashboard' })
  expect(result.outcome.status).toBe('matched')
  expect(result.application.status).toBe('accepted')
  expect(getApplication(db, app.id)?.status).toBe('accepted')
  expect(listEvents(db, app.id)).toHaveLength(2)
})

test('matchOutcome rejects unknown ids without side effects', () => {
  const outcome = rejection()
  expect(() => matchOutcome(db, outcome.id, 999, { source: 'dashboard' })).toThrow('application 999 not found')
  expect(listOutcomes(db, { status: 'needs_match' })).toHaveLength(1)
  expect(() => matchOutcome(db, 999, application().id, { source: 'dashboard' })).toThrow('outcome 999 not found')
})

test('dismissOutcome removes the outcome from the queue', () => {
  const outcome = rejection()
  expect(dismissOutcome(db, outcome.id).status).toBe('dismissed')
  expect(listOutcomes(db, { status: 'needs_match' })).toHaveLength(0)
  expect(() => dismissOutcome(db, 999)).toThrow('outcome 999 not found')
})

test('matchOutcome records matched_by when given', () => {
  const app = application()
  const result = matchOutcome(db, rejection().id, app.id, { source: 'sync', matchedBy: 'url' })
  expect(result.outcome.matched_by).toBe('url')
  expect(listEvents(db, app.id).at(-1)?.source).toBe('sync')
})

test('markSynced stamps synced_at on the given outcomes only', () => {
  const a = rejection('msg-a')
  const b = rejection('msg-b')
  const c = rejection('msg-c')
  expect(markSynced(db, [a.id, c.id], '2026-10-02T00:00:00.000Z')).toBe(2)
  expect(getOutcome(db, a.id)?.synced_at).toBe('2026-10-02T00:00:00.000Z')
  expect(getOutcome(db, b.id)?.synced_at).toBeNull()
  expect(getOutcome(db, c.id)?.synced_at).toBe('2026-10-02T00:00:00.000Z')
  expect(markSynced(db, [], '2026-10-02T00:00:00.000Z')).toBe(0)
})

test('setNeedsMatch queues the outcome with its candidates', () => {
  const outcome = insertOutcome(db, { message_id: 'msg-n', kind: 'rejection', received_at: '2026-10-01T00:00:00.000Z', status: 'pending' })
  const candidates = [{ application_id: 1, company: 'Acme', title: 'AI Engineer', score: 0.5 }]
  const row = setNeedsMatch(db, outcome.id, candidates)
  expect(row.status).toBe('needs_match')
  expect(JSON.parse(row.candidates ?? 'null')).toEqual(candidates)
  expect(listOutcomes(db, { status: 'needs_match' }).map((o) => o.id)).toEqual([outcome.id])
  expect(() => setNeedsMatch(db, 999, [])).toThrow('outcome 999 not found')
})

test('listLiveApplicationsForMatching skips terminal and deleted applications', () => {
  const live = application()
  application('accepted')
  const gone = createApplication(db, {
    postingId: upsertPosting(db, { source: 'manual', url: 'https://acme.com/jobs/gone', title: 'AI Engineer', company: 'Acme' }).id,
    status: 'applied',
  })
  softDeleteApplication(db, gone.id)
  const rows = listLiveApplicationsForMatching(db)
  expect(rows.map((row) => row.id)).toEqual([live.id])
  expect(rows[0]).toMatchObject({ company: 'Acme', title: 'AI Engineer', url_key: 'acme.com/jobs/applied', source_id: null })
})

const signal = (kind: OutcomeKind, options: { messageId?: string; scheduledAt?: string | null; status?: 'needs_match' | 'pending' } = {}) =>
  insertOutcome(db, {
    message_id: options.messageId ?? `sig-${kind}`, kind, company: 'Acme', title: 'AI Engineer',
    received_at: '2026-10-01T12:00:00.000Z', status: options.status ?? 'needs_match',
    scheduled_at: options.scheduledAt ?? null,
  })

test('matching an interview signal holds it in awaiting_confirm and never closes the application', () => {
  for (const kind of ['interview_invite', 'assessment', 'offer'] as const) {
    const app = application()
    const before = listEvents(db, app.id).length
    const result = matchOutcome(db, signal(kind).id, app.id, { source: 'dashboard' })
    expect(result.outcome).toMatchObject({ status: 'awaiting_confirm', matched_by: 'dashboard', application_id: app.id })
    expect(result.stage).toBeUndefined()
    expect(getApplication(db, app.id)?.status).toBe('applied')
    expect(getApplication(db, app.id)?.closed_at).toBeNull()
    expect(listEvents(db, app.id)).toHaveLength(before)
    expect(listEvents(db, app.id).some((event) => event.to_status === 'deny_by_employer')).toBe(false)
    db.prepare('DELETE FROM outcomes').run()
    softDeleteApplication(db, app.id)
  }
})

test('confirm maps each kind to its stage kind and type and keeps the scheduled date part', () => {
  const cases = [
    ['interview_invite', 'interviewing', 'other', 'pending'],
    ['assessment', 'interviewing', 'online_assessment', 'pending'],
    ['offer', 'offered', 'verbal', null],
  ] as const
  for (const [kind, stageKind, stageType, stageOutcome] of cases) {
    const app = application()
    const outcome = signal(kind, { scheduledAt: '2026-10-09T09:30:00+02:00' })
    matchOutcome(db, outcome.id, app.id, { source: 'dashboard' })
    const result = confirmOutcome(db, outcome.id, { source: 'dashboard' })
    expect(result.outcome).toMatchObject({ status: 'matched', application_id: app.id, scheduled_at: '2026-10-09T09:30:00+02:00' })
    expect(result.application.status).toBe(stageKind)
    expect(result.stage).toMatchObject({
      to_status: stageKind, stage_type: stageType, scheduled_at: '2026-10-09', outcome: stageOutcome, source: 'dashboard',
    })
    expect(result.stage?.note).toContain('email 2026-10-01T12:00:00.000Z')
    expect(listStages(db, app.id)).toHaveLength(1)
    db.prepare('DELETE FROM outcomes').run()
    softDeleteApplication(db, app.id)
  }
})

test('confirm without a scheduled date records an undated stage', () => {
  const app = application()
  const outcome = signal('interview_invite')
  matchOutcome(db, outcome.id, app.id, { source: 'dashboard' })
  expect(confirmOutcome(db, outcome.id, { source: 'dashboard' }).stage?.scheduled_at).toBeNull()
})

test('confirm moves the status forward only and leaves a terminal application as is', () => {
  const offered = application('offered')
  const assessment = signal('assessment')
  matchOutcome(db, assessment.id, offered.id, { source: 'dashboard' })
  const forward = confirmOutcome(db, assessment.id, { source: 'dashboard' })
  expect(forward.application.status).toBe('offered')
  expect(forward.stage).toMatchObject({ to_status: 'interviewing', stage_type: 'online_assessment' })

  const closed = application('deny_by_candidate')
  const before = listEvents(db, closed.id).length
  const offer = signal('offer')
  matchOutcome(db, offer.id, closed.id, { source: 'dashboard' })
  const terminal = confirmOutcome(db, offer.id, { source: 'dashboard' })
  expect(terminal.outcome.status).toBe('matched')
  expect(terminal.stage).toBeUndefined()
  expect(getApplication(db, closed.id)?.status).toBe('deny_by_candidate')
  expect(listEvents(db, closed.id)).toHaveLength(before)
})

test('confirm refuses outcomes that are not awaiting confirmation', () => {
  const app = application()
  const queued = signal('interview_invite')
  expect(() => confirmOutcome(db, queued.id, { source: 'dashboard' })).toThrow('is not awaiting confirmation')
  matchOutcome(db, queued.id, app.id, { source: 'dashboard' })
  confirmOutcome(db, queued.id, { source: 'dashboard' })
  expect(() => confirmOutcome(db, queued.id, { source: 'dashboard' })).toThrow('is not awaiting confirmation')
  expect(() => matchOutcome(db, queued.id, app.id, { source: 'dashboard' })).toThrow('already recorded')
  expect(listStages(db, app.id)).toHaveLength(1)
  expect(() => confirmOutcome(db, rejection().id, { source: 'dashboard' })).toThrow('is not awaiting confirmation')
  expect(() => confirmOutcome(db, 999, { source: 'dashboard' })).toThrow('outcome 999 not found')
})

test('matchOutcome with autoConfirm records the stage at once', () => {
  const app = application()
  const result = matchOutcome(db, signal('offer').id, app.id, { source: 'sync', matchedBy: 'url', autoConfirm: true })
  expect(result.outcome).toMatchObject({ status: 'matched', matched_by: 'url' })
  expect(result.application.status).toBe('offered')
  expect(result.stage).toMatchObject({ to_status: 'offered', stage_type: 'verbal', source: 'sync' })
})

const api = (method: string, path: string, body?: unknown) =>
  handleApi({ db, home: box.home }, { method, path, query: new URLSearchParams(), body }) as { status: number; body: any }

test('POST /api/outcomes/:id/match holds an interview signal and /confirm records it', () => {
  const app = application()
  const outcome = signal('interview_invite', { scheduledAt: '2026-10-08' })
  const matched = api('POST', `/api/outcomes/${outcome.id}/match`, { application_id: app.id })
  expect(matched.status).toBe(200)
  expect(matched.body.outcome).toMatchObject({ status: 'awaiting_confirm', application_id: app.id })
  expect(matched.body.application.status).toBe('applied')
  expect(api('GET', '/api/outcomes', undefined).body).toHaveLength(1)
  const listed = handleApi({ db, home: box.home }, {
    method: 'GET', path: '/api/outcomes', query: new URLSearchParams({ status: 'awaiting_confirm' }), body: undefined,
  }).body as { id: number; kind: string; scheduled_at: string }[]
  expect(listed.map((row) => [row.id, row.kind, row.scheduled_at])).toEqual([[outcome.id, 'interview_invite', '2026-10-08']])

  const confirmed = api('POST', `/api/outcomes/${outcome.id}/confirm`)
  expect(confirmed.status).toBe(200)
  expect(confirmed.body.outcome.status).toBe('matched')
  expect(confirmed.body.application.status).toBe('interviewing')
  expect(confirmed.body.stage).toMatchObject({ stage_type: 'other', scheduled_at: '2026-10-08', source: 'dashboard' })
  expect(api('POST', `/api/outcomes/${outcome.id}/confirm`).status).toBe(409)
  expect(api('POST', `/api/outcomes/${outcome.id}/match`, { application_id: app.id }).status).toBe(409)
  expect(api('POST', '/api/outcomes/999/confirm').status).toBe(404)
  expect(api('POST', `/api/outcomes/${rejection('msg-r').id}/confirm`).status).toBe(409)
})

test('POST /api/outcomes/:id/dismiss drops an awaiting_confirm signal without touching the application', () => {
  const app = application()
  const outcome = signal('offer')
  api('POST', `/api/outcomes/${outcome.id}/match`, { application_id: app.id })
  expect(api('POST', `/api/outcomes/${outcome.id}/dismiss`).body.status).toBe('dismissed')
  expect(api('POST', `/api/outcomes/${outcome.id}/confirm`).status).toBe(409)
  expect(getApplication(db, app.id)?.status).toBe('applied')
})

test('POST /api/outcomes/:id/match confirms at once when auto_apply_interview_signals is on', () => {
  writeFileSync(permissionsPath(box.home), '[track]\nauto_apply_interview_signals = true\n')
  const app = application()
  const matched = api('POST', `/api/outcomes/${signal('assessment').id}/match`, { application_id: app.id })
  expect(matched.status).toBe(200)
  expect(matched.body.outcome.status).toBe('matched')
  expect(matched.body.application.status).toBe('interviewing')
  expect(matched.body.stage).toMatchObject({ stage_type: 'online_assessment', source: 'dashboard' })
  expect(listEvents(db, app.id).some((event) => event.to_status === 'deny_by_employer')).toBe(false)
})
