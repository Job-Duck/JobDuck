import { useState } from 'react'
import { RefreshCwIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useFlash } from '@/hooks/use-flash'
import { errorMessage, postJSON } from '@/lib/api'
import { SYNC_PATH, newCount, scheduleLabel, syncLine } from '@/lib/sync'
import type { SyncStatus } from '@/lib/types'
import { cn } from '@/lib/utils'

interface SyncStatusBarProps {
  status: SyncStatus | null
  onSynced: (next: SyncStatus) => Promise<void>
}

export function SyncStatusBar({ status, onSynced }: SyncStatusBarProps) {
  const flash = useFlash()
  const [busy, setBusy] = useState(false)
  if (!status?.configured) return null
  const failed = status.last !== null && !status.last.ok && !status.running

  const syncNow = async () => {
    setBusy(true)
    try {
      const next = await postJSON<SyncStatus>(SYNC_PATH)
      const last = next.last
      if (last && !last.ok) flash(`Sync failed: ${last.error ?? 'unknown error'}`, true)
      else flash(`Synced: ${last?.totals ? newCount(last.totals) : 0} new`)
      await onSynced(next)
    } catch (error) {
      flash(errorMessage(error), true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <RefreshCwIcon className={cn('size-4 shrink-0 text-muted-foreground', status.running && 'animate-spin')} aria-hidden />
      <span role="status" className={cn('min-w-0', failed ? 'text-destructive' : 'text-muted-foreground')}>{syncLine(status)}</span>
      <span className="text-xs text-muted-foreground">{scheduleLabel(status)}</span>
      <Button type="button" variant="outline" size="sm" className="ml-auto" disabled={busy || status.running} onClick={() => void syncNow()}>
        Sync now
      </Button>
    </div>
  )
}
