import { useState } from 'react'
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SaveResult } from '@/lib/api'
import {
  PENDING_GROUP_LABEL, type TimelineGroup as Group, effectiveDate, groupLatest, groupNote, timeRangeLabel, timelineLabel,
} from '@/lib/status-entries'
import { TimelineEntry } from '@/views/applications/timeline-entry'
import { UndoEntryButton } from '@/views/applications/undo-entry-button'

interface TimelineGroupProps {
  group: Group
  undoable: number | null
  openVersion: () => () => string
  onSave: (eventId: number, body: Record<string, unknown>) => Promise<SaveResult>
  onUndo: (eventId: number) => Promise<SaveResult>
}

export function TimelineGroup({ group, undoable, openVersion, onSave, onUndo }: TimelineGroupProps) {
  const [open, setOpen] = useState(false)
  const latest = groupLatest(group)
  const members = [group.head, ...group.updates]
  const target = members.find((event) => event.id === undoable)
  const note = groupNote(group)
  const count = group.updates.length
  const listId = `entry-group-${group.head.id}`

  return (
    <li className="space-y-0.5">
      <div className="flex items-start justify-between gap-2">
        <p>{PENDING_GROUP_LABEL}</p>
        {target && (
          <div className="-mt-1 flex shrink-0">
            <UndoEntryButton event={target} label={timelineLabel(target)} onUndo={() => onUndo(target.id)} />
          </div>
        )}
      </div>
      {note && <p className="whitespace-pre-wrap text-muted-foreground">{note}</p>}
      <p className="text-xs text-muted-foreground">
        {timeRangeLabel(effectiveDate(group.head), effectiveDate(latest))} · {latest.source}
      </p>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="-ml-2 text-muted-foreground"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDownIcon data-icon="inline-start" /> : <ChevronRightIcon data-icon="inline-start" />}
        {open ? 'Hide updates' : `Show ${count} ${count === 1 ? 'update' : 'updates'}`}
      </Button>
      {open && (
        <ol id={listId} className="space-y-3 border-l pt-1 pl-4">
          {members.map((event) => (
            <TimelineEntry
              key={event.id}
              event={event}
              label={timelineLabel(event)}
              undoable={false}
              openVersion={openVersion}
              onSave={(body) => onSave(event.id, body)}
              onUndo={() => onUndo(event.id)}
            />
          ))}
        </ol>
      )}
    </li>
  )
}
