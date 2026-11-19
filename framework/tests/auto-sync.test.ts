import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { type Sandbox, migratedDb, sandbox } from './helpers'
import { SYNC_NOT_CONFIGURED, createDashboardSync, handleSync } from '../src/dashboard/sync'
import { createApplication, getApplication } from '../src/db/applications'
import type { Db } from '../src/db/client'
import { listOutcomes } from '../src/db/outcomes'
import { upsertPosting } from '../src/db/postings'
import { permissionsPath } from '../src/paths'
import {
  type AutoSync, type AutoSyncStatus, FIRST_RUN_DELAY_MS, MAX_TIMER_MS, SyncBusyError, createAutoSync, unrefTimer,
} from '../src/sync/auto'
import type { FetchLike } from '../src/sync/client'

const SYNC_URL = 'https://script.example.com/macros/s/abc/exec'
const TOKEN = 'auto-sync-secret-token-0123456789'
const MINUTE = 60_000

type Reply = (body: { token: string; action: string; messageIds?: string[] }) => Response | Promise<Response>

class FakeClock {
  t = 0
  private seq = 0
  readonly timers = new Map<number, { at: number; fn: () => void }>()
  readonly delays: number[] = []
  readonly setTimer = (fn: () => void, ms: number) => {
    const id = ++this.seq
    this.delays.push(ms)
    this.timers.set(id, { at: this.t + ms, fn })
    return id
  }
  readonly clearTimer = (id: unknown) => {
    this.timers.delete(id as number)
  }
  readonly now = () => new Date(Date.UTC(2026, 10, 17) + this.t)

  async advance(ms: number) {
    const end = this.t + ms
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.timers.delete(due[0])
      this.t = due[1].at
      due[1].fn()
      await settle()
    }
    this.t = end
    await settle()
  }
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

let box: Sandbox
let db: Db
let clock: FakeClock
let logged: string[]
let actions: string[]
let reply: Reply
let sync: AutoSync

beforeEach(() => {
  box = sandbox()
  db = migratedDb(box.home)
  clock = new FakeClock()
  logged = []
  actions = []
  reply = ok([])
})
afterEach(() => {
  sync?.stop()
  db.close()
  box.cleanup()
})

function configure(track: { url?: string; token?: string; minutes?: number } = {}) {
  const minutes = track.minutes === undefined ? '' : `auto_sync_minutes = ${track.minutes}\n`
  writeFileSync(permissionsPath(box.home),
    `[modules]\ntrack = true\n\n[track]\nsync_url = "${track.url ?? SYNC_URL}"\nsync_token = "${track.token ?? TOKEN}"\n${minutes}`)
}

function ok(outcomes: unknown[]): Reply {
  return (body) => {
    if (body.action === 'pending') return Response.json({ ok: true, scriptVersion: '4', outcomes })
    if (body.action === 'ack') return Response.json({ ok: true, acked: body.messageIds?.length ?? 0 })
    return Response.json({ ok: false, error: 'bad_request' })
  }
}

const fetch: FetchLike = async (_url, init) => {
  const body = JSON.parse(String(init.body)) as Parameters<Reply>[0]
  actions.push(body.action)
  return reply(body)
}

function start(): AutoSync {
  sync = createDashboardSync({
    db, home: box.home, out: (line) => { logged.push(line) }, fetch,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now,
  })
  sync.start()
  return sync
}

const pendingCalls = () => actions.filter((action) => action === 'pending').length

function acmeApplication() {
  const posting = upsertPosting(db, { source: 'manual', url: 'https://jobs.example.com/acme/1', title: 'AI Engineer', company: 'Acme' })
  return createApplication(db, { postingId: posting.id, status: 'applied', appliedAt: '2026-09-01T00:00:00.000Z' })
}

const rejection = (messageId: string, applicationId: number) => ({
  messageId, receivedAt: '2026-10-01T12:00:00.000Z', company: 'Acme', title: 'AI Engineer', applicationId,
})

test('the first run comes 10 s after start, then one every interval, and fills last with totals', async () => {
  configure()
  const app = acmeApplication()
  reply = ok([rejection('m1', app.id)])
  start()
  expect(sync.status()).toMatchObject({ configured: true, enabled: true, interval_minutes: 15, running: false, last: null })

  await clock.advance(FIRST_RUN_DELAY_MS - 1)
  expect(pendingCalls()).toBe(0)
  await clock.advance(1)
  expect(pendingCalls()).toBe(1)
  expect(actions).toEqual(['pending', 'ack'])
  const last = sync.status().last!
  expect(last.at).toBe(new Date(Date.UTC(2026, 10, 17) + FIRST_RUN_DELAY_MS).toISOString())
  expect(last.ok).toBe(true)
  expect(last.totals).toMatchObject({ fetched: 1, matched: { total: 1, marker: 1 }, known: 0 })
  expect(getApplication(db, app.id)?.status).toBe('deny_by_employer')
  expect(listOutcomes(db)[0]?.synced_at).not.toBeNull()

  await clock.advance(15 * MINUTE - 1)
  expect(pendingCalls()).toBe(1)
  await clock.advance(1)
  expect(pendingCalls()).toBe(2)
  expect(sync.status().last?.totals).toMatchObject({ fetched: 1, known: 1 })
  await clock.advance(30 * MINUTE)
  expect(pendingCalls()).toBe(4)
})

test('a run in flight makes the next tick skip and a manual run get 409, never two at once', async () => {
  configure()
  let release: () => void = () => undefined
  const slow = new Promise<void>((resolve) => { release = resolve })
  const quick = ok([])
  reply = async (body) => {
    if (body.action === 'pending' && pendingCalls() === 1) await slow
    return quick(body)
  }
  start()
  await clock.advance(FIRST_RUN_DELAY_MS)
  expect(sync.status().running).toBe(true)
  await clock.advance(15 * MINUTE)
  expect(pendingCalls()).toBe(1)
  expect(await handleSync(sync, 'POST')).toMatchObject({ status: 409 })
  await expect(sync.runNow()).rejects.toBeInstanceOf(SyncBusyError)

  release()
  await settle()
  expect(sync.status()).toMatchObject({ running: false, last: { ok: true } })
  await clock.advance(15 * MINUTE)
  expect(pendingCalls()).toBe(2)
})

test('auto_sync_minutes = 0 never sets a timer, but Sync now still runs', async () => {
  configure({ minutes: 0 })
  start()
  expect(clock.timers.size).toBe(0)
  await clock.advance(120 * MINUTE)
  expect(pendingCalls()).toBe(0)
  expect(sync.status()).toMatchObject({ configured: true, enabled: false, interval_minutes: 0, last: null })

  const response = await handleSync(sync, 'POST')
  expect(response.status).toBe(200)
  expect((response.body as AutoSyncStatus).last?.ok).toBe(true)
  expect(pendingCalls()).toBe(1)
  expect(clock.timers.size).toBe(0)
})

test('without sync_url or sync_token nothing ever runs, and Sync now gets 400', async () => {
  configure({ url: '' })
  start()
  expect(clock.timers.size).toBe(0)
  await clock.advance(120 * MINUTE)
  expect(actions).toEqual([])
  expect(await handleSync(sync, 'GET')).toEqual({
    status: 200, body: { configured: false, enabled: false, interval_minutes: 15, running: false, last: null },
  })
  expect(await handleSync(sync, 'POST')).toEqual({ status: 400, body: { error: SYNC_NOT_CONFIGURED } })
  expect(actions).toEqual([])
  sync.stop()

  configure({ token: '  ' })
  start()
  await clock.advance(120 * MINUTE)
  expect(actions).toEqual([])

  sync.stop()
  writeFileSync(permissionsPath(box.home), `[modules]\ntrack = false\n\n[track]\nsync_url = "${SYNC_URL}"\nsync_token = "${TOKEN}"\n`)
  start()
  await clock.advance(120 * MINUTE)
  expect(actions).toEqual([])
})

test('a rejected token stops the timer until Sync now succeeds', async () => {
  configure()
  reply = () => Response.json({ ok: false, error: 'unauthorized' })
  start()
  await clock.advance(FIRST_RUN_DELAY_MS)
  expect(pendingCalls()).toBe(1)
  expect(clock.timers.size).toBe(0)
  const paused = sync.status()
  expect(paused).toMatchObject({ configured: true, enabled: false, last: { ok: false } })
  expect(paused.last?.error).toContain('sync_token rejected')
  await clock.advance(120 * MINUTE)
  expect(pendingCalls()).toBe(1)

  expect((await sync.runNow()).last?.ok).toBe(false)
  expect(clock.timers.size).toBe(0)

  reply = ok([])
  const resumed = await sync.runNow()
  expect(resumed).toMatchObject({ enabled: true, last: { ok: true } })
  expect(clock.timers.size).toBe(1)
  await clock.advance(15 * MINUTE)
  expect(pendingCalls()).toBe(4)
})

test('a token rejected on ack also stops the timer until Sync now succeeds', async () => {
  configure()
  const app = acmeApplication()
  const fetchOk = ok([rejection('m1', app.id)])
  reply = (body) => (body.action === 'ack' ? Response.json({ ok: false, error: 'unauthorized' }) : fetchOk(body))
  start()
  await clock.advance(FIRST_RUN_DELAY_MS)
  expect(actions).toEqual(['pending', 'ack'])
  expect(clock.timers.size).toBe(0)
  const paused = sync.status()
  expect(paused).toMatchObject({ configured: true, enabled: false, last: { ok: false, totals: { fetched: 1 } } })
  expect(paused.last?.error).toContain('sync_token rejected')
  expect(logged.some((line) => line.includes('paused'))).toBe(true)
  await clock.advance(120 * MINUTE)
  expect(pendingCalls()).toBe(1)

  reply = fetchOk
  expect(await sync.runNow()).toMatchObject({ enabled: true, last: { ok: true } })
  expect(clock.timers.size).toBe(1)
  await clock.advance(15 * MINUTE)
  expect(pendingCalls()).toBe(3)
})

test('a huge interval is clamped to the longest setTimeout delay and never fires early', async () => {
  let runs = 0
  const totals = { fetched: 0, matched: { total: 0, marker: 0, url: 0, ref: 0, company_title: 0 }, awaiting_confirm: 0, needs_match: 0, known: 0, failed: 0 }
  sync = createAutoSync({
    settings: () => ({ configured: true, intervalMinutes: 99_999 }),
    run: async () => {
      runs++
      return { totals, errors: [] }
    },
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now,
  })
  sync.start()
  await clock.advance(FIRST_RUN_DELAY_MS)
  expect(runs).toBe(1)
  await clock.advance(MAX_TIMER_MS - 1)
  expect(runs).toBe(1)
  await clock.advance(1)
  expect(runs).toBe(2)
  sync.refresh()
  await sync.runNow()
  expect(clock.delays[0]).toBe(FIRST_RUN_DELAY_MS)
  expect(clock.delays.slice(1).length).toBeGreaterThan(1)
  for (const delay of clock.delays.slice(1)) expect(delay).toBe(MAX_TIMER_MS)
})

test('an out-of-range auto_sync_minutes in permissions.toml never schedules anything', async () => {
  configure({ minutes: 99_999 })
  start()
  expect(clock.timers.size).toBe(0)
  await clock.advance(120 * MINUTE)
  expect(actions).toEqual([])
  expect(sync.status()).toMatchObject({ configured: false, enabled: false })
})

test('stop() clears the pending timer and nothing runs afterwards', async () => {
  configure()
  start()
  expect(clock.timers.size).toBe(1)
  sync.stop()
  expect(clock.timers.size).toBe(0)
  await clock.advance(120 * MINUTE)
  expect(actions).toEqual([])
  sync.refresh()
  expect(clock.timers.size).toBe(0)
})

test('refresh() applies a Settings change: 0 clears the timer, a new interval reschedules', async () => {
  configure()
  start()
  await clock.advance(FIRST_RUN_DELAY_MS)
  configure({ minutes: 0 })
  sync.refresh()
  expect(clock.timers.size).toBe(0)
  configure({ minutes: 5 })
  sync.refresh()
  await clock.advance(5 * MINUTE)
  expect(pendingCalls()).toBe(2)
})

test('the token never appears in a logged line, the last error or a /api/sync response', async () => {
  configure()
  reply = (body) => new Response(`server echoed ${JSON.stringify(body)}`, { status: 500 })
  start()
  await clock.advance(FIRST_RUN_DELAY_MS)
  expect(logged.length).toBeGreaterThan(0)
  expect(logged.join('\n')).toContain('HTTP 500')
  expect(logged.join('\n')).toContain('[redacted]')

  reply = (body) => body.action === 'ack'
    ? new Response(`ack echoed ${JSON.stringify(body)}`, { status: 500 })
    : ok([{ messageId: 'm1', receivedAt: '2026-10-01T12:00:00.000Z', company: 'Acme' }])(body)
  const manual = await handleSync(sync, 'POST')
  expect((manual.body as AutoSyncStatus).last).toMatchObject({ ok: false, totals: { fetched: 1, needs_match: 1 } })

  reply = () => Response.json({ ok: false, error: 'unauthorized' })
  await handleSync(sync, 'POST')
  const get = await handleSync(sync, 'GET')
  for (const text of [...logged, JSON.stringify(manual.body), JSON.stringify(get.body)]) expect(text).not.toContain(TOKEN)
  expect(logged.some((line) => line.includes('ack failed'))).toBe(true)
  expect(logged.some((line) => line.includes('paused'))).toBe(true)
})

test('other methods on /api/sync get 405, and the default timer is unref\'d', async () => {
  configure()
  start()
  expect(await handleSync(sync, 'DELETE')).toMatchObject({ status: 405 })
  const timer = unrefTimer(() => undefined, 60_000)
  expect(timer.hasRef()).toBe(false)
  clearTimeout(timer)
})
