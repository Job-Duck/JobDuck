import { stamp } from './format'
import type { ScheduleMode, ScheduleStatus, ScheduledRun } from './types'

export const SCHEDULE_PATH = '/api/schedule'

const MODE_LABELS: Record<ScheduleMode, string> = { find_only: 'Find Only', apply: 'Apply' }
const HOST_LABELS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex CLI', gemini: 'Gemini CLI' }

export const scheduleModeLabel = (mode: ScheduleMode) => MODE_LABELS[mode] ?? mode
export const scheduleHostLabel = (host: string) => HOST_LABELS[host] ?? host

/** The card shows once a run exists, or while scheduled runs are on. */
export const showScheduleCard = (status: ScheduleStatus | null): status is ScheduleStatus =>
  status !== null && (status.last_run !== null || status.settings.enabled)

export const isRunning = (run: ScheduledRun) => run.finished_at === null

export function runTimeLine(run: ScheduledRun): string {
  const how = `${scheduleModeLabel(run.mode)} with ${scheduleHostLabel(run.host)}`
  return isRunning(run) ? `Running since ${stamp(run.started_at)} · ${how}` : `${stamp(run.started_at)} · ${how}`
}

export interface RunCount {
  label: string
  value: number
}

export const runCounts = (run: ScheduledRun): RunCount[] => [
  { label: 'Found', value: run.found ?? 0 },
  { label: 'Applied', value: run.applied ?? 0 },
  { label: 'Pending', value: run.pending ?? 0 },
]

export const scheduleLine = (status: ScheduleStatus) =>
  status.settings.enabled ? `Runs Daily At ${status.settings.time}` : 'Scheduled Runs Off'

export const NO_RUN_YET = 'No scheduled run yet.'
