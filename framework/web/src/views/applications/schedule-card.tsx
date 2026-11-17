import { AlarmClockIcon, AlertCircleIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { NO_RUN_YET, isRunning, runCounts, runTimeLine, scheduleLine, showScheduleCard } from '@/lib/schedule'
import type { ScheduleStatus } from '@/lib/types'

export function ScheduleCard({ status }: { status: ScheduleStatus | null }) {
  if (!showScheduleCard(status)) return null
  const run = status.last_run
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlarmClockIcon className="size-4 text-primary" aria-hidden="true" />
          <h2>Last Scheduled Run</h2>
        </CardTitle>
        <CardDescription>{run ? runTimeLine(run) : NO_RUN_YET}</CardDescription>
        <CardAction>
          <Badge variant={status.settings.enabled ? 'secondary' : 'outline'}>{scheduleLine(status)}</Badge>
        </CardAction>
      </CardHeader>
      {run && !isRunning(run) && (
        <CardContent className="flex flex-col gap-3">
          <dl className="grid grid-cols-3 gap-4">
            {runCounts(run).map((count) => (
              <div key={count.label} className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">{count.label}</dt>
                <dd className="text-2xl font-semibold tabular-nums">{count.value}</dd>
              </div>
            ))}
          </dl>
          {run.error && (
            <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{run.error}</span>
            </p>
          )}
        </CardContent>
      )}
    </Card>
  )
}
