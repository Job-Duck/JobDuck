import { stamp } from './format'

const SIGNAL_LABELS: Record<string, string> = {
  interview_invite: 'Possible interview',
  assessment: 'Possible assessment',
  offer: 'Possible offer',
}

export const isSignal = (kind: string) => kind in SIGNAL_LABELS

export const signalLabel = (kind: string) => SIGNAL_LABELS[kind] ?? 'Possible update'

export function matchedMessage(kind: string, status: string): string {
  if (!isSignal(kind)) return 'Matched; application closed as deny by employer.'
  return status === 'awaiting_confirm' ? 'Matched; confirm it under Possible Updates.' : 'Matched and recorded on the application.'
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

export function scheduledLabel(value: string | null): string | null {
  if (!value) return null
  const date = DATE_ONLY.exec(value)
  if (!date) return stamp(value)
  return new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])).toLocaleDateString()
}
