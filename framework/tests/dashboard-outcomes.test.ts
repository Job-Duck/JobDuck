import { expect, test } from 'bun:test'
import { SETTINGS_GROUPS } from '../web/src/lib/forms'
import { isSignal, matchedMessage, scheduledLabel, signalLabel } from '../web/src/lib/outcomes'

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
