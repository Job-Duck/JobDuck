import { expect, test } from 'bun:test'
import { SETTINGS_GROUPS } from '../web/src/lib/forms'
import { isSignal, matchedMessage, scheduledLabel, signalLabel } from '../web/src/lib/outcomes'
import { newCount, scheduleLabel, syncLine } from '../web/src/lib/sync'
import type { SyncStatus } from '../web/src/lib/types'

test('each interview kind gets its "Possible …" label and rejections are not signals', () => {
  expect(signalLabel('interview_invite')).toBe('Possible interview')
  expect(signalLabel('assessment')).toBe('Possible assessment')
  expect(signalLabel('offer')).toBe('Possible offer')
  expect(isSignal('offer')).toBe(true)
  expect(isSignal('rejection')).toBe(false)
})

test('the match message says what happened to the application', () => {
  expect(matchedMessage('rejection', 'matched')).toBe('Matched; application closed as deny by employer.')
  expect(matchedMessage('interview_invite', 'awaiting_confirm')).toContain('confirm')
  expect(matchedMessage('offer', 'matched')).toBe('Matched and recorded on the application.')
})

test('a date-only scheduled_at shows that calendar day, and null shows nothing', () => {
  expect(scheduledLabel(null)).toBeNull()
  expect(scheduledLabel('2026-10-08')).toBe(new Date(2026, 9, 8).toLocaleDateString())
  expect(scheduledLabel('2026-10-08T15:00:00Z')).toBe(new Date('2026-10-08T15:00:00Z').toLocaleString())
})

test('Email Sync offers the auto_apply_interview_signals checkbox', () => {
  const group = SETTINGS_GROUPS.find((candidate) => candidate.title === 'Email Sync')!
  expect(group.fields.find((field) => field.key === 'track.auto_apply_interview_signals')?.type).toBe('checkbox')
})

test('Email Sync offers auto_sync_minutes as a number from 0 to 1440', () => {
  const group = SETTINGS_GROUPS.find((candidate) => candidate.title === 'Email Sync')!
  expect(group.fields.find((field) => field.key === 'track.auto_sync_minutes')).toMatchObject({ type: 'number', min: 0, max: 1440 })
})

test('the sync line shows the last run with its new count, the error, or that none ran yet', () => {
  const totals = { fetched: 5, matched: { total: 2 }, awaiting_confirm: 1, needs_match: 1, known: 1, failed: 0 }
  const base: SyncStatus = { configured: true, enabled: true, interval_minutes: 15, running: false, last: null }
  const at = '2026-11-17T12:00:00.000Z'
  expect(newCount(totals)).toBe(4)
  expect(syncLine(base)).toContain('first sync runs shortly')
  expect(syncLine({ ...base, enabled: false })).toBe('Not synced yet.')
  expect(syncLine({ ...base, last: { at, ok: true, totals } })).toBe(`Last synced ${new Date(at).toLocaleString()} · 4 new`)
  expect(syncLine({ ...base, last: { at, ok: false, error: 'sync pending failed: HTTP 500' } })).toContain('HTTP 500')
  expect(syncLine({ ...base, running: true, last: { at, ok: true, totals } })).toContain('Syncing')
  expect(scheduleLabel(base)).toBe('Auto-sync every 15 min')
  expect(scheduleLabel({ ...base, enabled: false })).toBe('Auto-sync off')
})
