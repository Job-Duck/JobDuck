import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useFlash } from '@/hooks/use-flash'
import { errorMessage, postJSON } from '@/lib/api'
import { stamp } from '@/lib/format'
import { scheduledLabel, signalLabel } from '@/lib/outcomes'
import type { Outcome } from '@/lib/types'

interface SignalItemProps {
  outcome: Outcome
  onChanged: () => Promise<void>
}

export function SignalItem({ outcome, onChanged }: SignalItemProps) {
  const flash = useFlash()
  const [busy, setBusy] = useState(false)
  const scheduled = scheduledLabel(outcome.scheduled_at)

  const run = async (action: 'confirm' | 'dismiss', message: string) => {
    setBusy(true)
    try {
      await postJSON(`/api/outcomes/${outcome.id}/${action}`)
      flash(message)
      await onChanged()
    } catch (error) {
      flash(errorMessage(error), true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="flex flex-col gap-3 border-b py-3 last:border-b-0 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-medium">{signalLabel(outcome.kind)} — {outcome.company || 'Unknown Company'}</p>
        <p className="truncate text-muted-foreground">{outcome.title || outcome.job_ref || ''}</p>
        <p className="text-xs text-muted-foreground">
          Received {stamp(outcome.received_at)}
          {scheduled && ` · Scheduled ${scheduled}`}
        </p>
      </div>
      <div className="flex gap-2">
        <Button type="button" disabled={busy} onClick={() => void run('confirm', 'Recorded on the application.')}>
          Confirm
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void run('dismiss', 'Dismissed.')}>
          Dismiss
        </Button>
      </div>
    </li>
  )
}
