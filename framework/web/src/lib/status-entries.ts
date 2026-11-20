import { followUpSentLabel } from './follow-ups'
import { statusLabel } from './format'
import { kindLabel, outcomeLabel, scheduledLabel, stageTypeLabel } from './stages'
import type { ApplicationEvent, StageKind, StageTypes } from './types'

export const CLOSE_TARGETS = ['deny_by_employer', 'deny_by_candidate', 'no_response'] as const
export const BULK_TARGETS = ['applied', 'interviewing', 'offered', 'accepted', ...CLOSE_TARGETS] as const

const ENTRY_LABELS: Record<string, string> = {
  applied: 'Applied',
  interviewing: 'Interviewing',
  offered: 'Offered',
  accepted: 'Accepted',
  deny_by_employer: 'Rejected',
  deny_by_candidate: 'Withdrew',
  no_response: 'No response',
}

export const entryLabel = (status: string) => ENTRY_LABELS[status] ?? status.replace(/_/g, ' ')

export interface DialogScope {
  stageKind: StageKind | null
  options: readonly string[]
  initial: string
}

const isStageKind = (target: string): target is StageKind => target === 'interviewing' || target === 'offered'

export function dialogScope(target: string, types: StageTypes | null, bulk = false): DialogScope {
  if (bulk) return { stageKind: null, options: BULK_TARGETS, initial: target }
  if (isStageKind(target)) {
    const options = types?.[target] ?? []
    return { stageKind: target, options, initial: options[0] ?? '' }
  }
  if ((CLOSE_TARGETS as readonly string[]).includes(target)) return { stageKind: null, options: CLOSE_TARGETS, initial: target }
  return { stageKind: null, options: [target], initial: target }
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

export function isEntryDate(value: string): boolean {
  const match = DATE_ONLY.exec(value)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

const UNDATED_CHOICES: readonly string[] = ['no_response']

export const needsDate = (scope: DialogScope, choice: string) => scope.stageKind !== null || !UNDATED_CHOICES.includes(choice)

export interface StatusEntry {
  choice: string
  date: string
  note: string
}

export interface StatusRequest {
  method: 'PATCH' | 'POST'
  path: string
  body: Record<string, unknown>
}

export function statusRequest(applicationId: number, scope: DialogScope, entry: StatusEntry, expected: string): StatusRequest {
  const dated = needsDate(scope, entry.choice)
  if (dated && !isEntryDate(entry.date)) throw new Error('Pick the date it happened.')
  const note = entry.note.trim() === '' ? {} : { note: entry.note }
  if (scope.stageKind !== null) {
    return {
      method: 'POST',
      path: `/api/applications/${applicationId}/stages`,
      body: { kind: scope.stageKind, stage_type: entry.choice, scheduled_at: entry.date, ...note, expected_updated_at: expected },
    }
  }
  return {
    method: 'PATCH',
    path: `/api/applications/${applicationId}`,
    body: { status: entry.choice, ...(dated ? { occurred_at: entry.date } : {}), ...note, expected_updated_at: expected },
  }
}

const isStageEntry = (event: ApplicationEvent) => event.stage_type !== null

export const effectiveDate = (event: ApplicationEvent) => event.occurred_at ?? event.scheduled_at ?? event.created_at

function dateValue(value: string): number {
  const match = DATE_ONLY.exec(value)
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

export function timelineOrder<T extends ApplicationEvent>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => dateValue(effectiveDate(b)) - dateValue(effectiveDate(a)) || b.id - a.id)
}

export interface TimelineGroup<T extends ApplicationEvent = ApplicationEvent> {
  head: T
  updates: T[]
}

export type TimelineItem<T extends ApplicationEvent = ApplicationEvent> = T | TimelineGroup<T>

export const isTimelineGroup = <T extends ApplicationEvent>(item: TimelineItem<T>): item is TimelineGroup<T> => 'head' in item

const isStatusEvent = (event: ApplicationEvent) => event.kind === null && event.stage_type === null
const isPendingUpdate = (event: ApplicationEvent) =>
  isStatusEvent(event) && event.from_status === 'pending' && event.to_status === 'pending'
const startsPending = (event: ApplicationEvent) =>
  isStatusEvent(event) && event.to_status === 'pending' && event.from_status !== 'pending'

export const groupLatest = <T extends ApplicationEvent>(group: TimelineGroup<T>): T => group.updates.at(-1) ?? group.head

export function groupTimeline<T extends ApplicationEvent>(events: readonly T[]): TimelineItem<T>[] {
  const byLatest = new Map<number, TimelineGroup<T>>()
  const folded = new Set<number>()
  const keep = (group: TimelineGroup<T> | null) => {
    if (!group || group.updates.length === 0) return
    for (const member of [group.head, ...group.updates]) folded.add(member.id)
    byLatest.set(groupLatest(group).id, group)
  }
  let open: TimelineGroup<T> | null = null
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    if (!isStatusEvent(event)) continue
    if (open && isPendingUpdate(event)) {
      open.updates.push(event)
      continue
    }
    keep(open)
    open = startsPending(event) ? { head: event, updates: [] } : null
  }
  keep(open)
  const items: TimelineItem<T>[] = []
  for (const event of timelineOrder(events)) {
    const group = byLatest.get(event.id)
    if (group) items.push(group)
    else if (!folded.has(event.id)) items.push(event)
  }
  return items
}

export const groupNote = (group: TimelineGroup): string | null =>
  [group.head, ...group.updates].reduce<string | null>((note, event) => event.note ?? note, null)

export const itemHolds = (item: TimelineItem, id: number | null): boolean =>
  id !== null && (isTimelineGroup(item) ? [item.head, ...item.updates].some((event) => event.id === id) : item.id === id)

const isStageEvent = (event: ApplicationEvent) =>
  event.stage_type !== null && (event.to_status === 'interviewing' || event.to_status === 'offered')

export const PENDING_GROUP_LABEL = 'Pending'

export function timelineLabel(event: ApplicationEvent): string {
  if (event.kind !== null) return followUpSentLabel(event.kind)
  if (isStageEvent(event)) {
    return [kindLabel(event.to_status as StageKind), stageTypeLabel(event.stage_type ?? ''), event.outcome && outcomeLabel(event.outcome)]
      .filter(Boolean).join(' · ')
  }
  if (isPendingUpdate(event)) return 'Pending reason updated'
  return event.from_status
    ? `${statusLabel(event.from_status)} → ${statusLabel(event.to_status)}`
    : `Created as ${statusLabel(event.to_status)}`
}

export function timeRangeLabel(from: string, to: string): string {
  const start = scheduledLabel(from)
  const end = scheduledLabel(to)
  if (start === end) return start
  if (!DATE_ONLY.test(from) && !DATE_ONLY.test(to)) {
    const last = new Date(to)
    if (new Date(from).toDateString() === last.toDateString()) return `${start}–${last.toLocaleTimeString()}`
  }
  return `${start} – ${end}`
}

export const isEditableEntry = (event: ApplicationEvent) => !isStageEntry(event)

export function undoableEntryId(events: readonly ApplicationEvent[]): number | null {
  const newest = events.reduce<ApplicationEvent | null>(
    (latest, event) => (event.kind === null && (latest === null || event.id > latest.id) ? event : latest), null)
  if (newest === null || isStageEntry(newest) || newest.from_status === null) return null
  return newest.id
}

export const revertsTo = (event: ApplicationEvent) => (event.from_status === 'pending' ? 'saved' : event.from_status)

export interface EntryDraft {
  date: string
  note: string
}

export const entryDraft = (event: ApplicationEvent, toInput: (value: string) => string): EntryDraft => ({
  date: toInput(effectiveDate(event)),
  note: event.note ?? '',
})

export function entryPatch(original: EntryDraft, draft: EntryDraft): Record<string, unknown> | null {
  if (!isEntryDate(draft.date)) return null
  const patch: Record<string, unknown> = {}
  if (draft.date !== original.date) patch.occurred_at = draft.date
  if (draft.note !== original.note) patch.note = draft.note.trim() === '' ? null : draft.note
  return Object.keys(patch).length > 0 ? patch : null
}
