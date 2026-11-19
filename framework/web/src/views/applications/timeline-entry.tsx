import { useRef, useState } from 'react'
import { PencilIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { SaveResult } from '@/lib/api'
import { dateInputValue, scheduledLabel } from '@/lib/stages'
import { type EntryDraft, effectiveDate, entryDraft, entryPatch, isEditableEntry, isEntryDate } from '@/lib/status-entries'
import type { ApplicationEvent } from '@/lib/types'
import { UndoEntryButton } from '@/views/applications/undo-entry-button'

interface TimelineEntryProps {
  event: ApplicationEvent
  label: string
  undoable: boolean
  openVersion: () => () => string
  onSave: (body: Record<string, unknown>) => Promise<SaveResult>
  onUndo: () => Promise<SaveResult>
}

export function TimelineEntry({ event, label, undoable, openVersion, onSave, onUndo }: TimelineEntryProps) {
  const [draft, setDraft] = useState<EntryDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const expected = useRef<() => string>(() => '')
  const original = entryDraft(event, dateInputValue)
  const patch = draft ? entryPatch(original, draft) : null
  const id = `entry-${event.id}`

  const edit = () => {
    expected.current = openVersion()
    setDraft(original)
  }

  const save = async () => {
    if (!patch) return
    setBusy(true)
    if (await onSave({ ...patch, expected_updated_at: expected.current() }) !== 'failed') setDraft(null)
    setBusy(false)
  }

  return (
    <li className="space-y-0.5">
      <div className="flex items-start justify-between gap-2">
        <p className={event.stage_type === null ? 'capitalize' : undefined}>{label}</p>
        {isEditableEntry(event) && !draft && (
          <div className="-mt-1 flex shrink-0">
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Edit entry" onClick={edit}>
              <PencilIcon />
            </Button>
            {undoable && <UndoEntryButton event={event} label={label} onUndo={onUndo} />}
          </div>
        )}
      </div>
      {draft ? (
        <div className="space-y-3 pt-1">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-date`} className="text-muted-foreground">Date</Label>
            <Input
              id={`${id}-date`}
              type="date"
              required
              value={draft.date}
              onChange={(change) => setDraft({ ...draft, date: change.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-note`} className="text-muted-foreground">Note</Label>
            <Textarea
              id={`${id}-note`}
              rows={3}
              value={draft.note}
              onChange={(change) => setDraft({ ...draft, note: change.target.value })}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setDraft(null)}>Cancel</Button>
            <Button type="button" size="sm" disabled={busy || !patch || !isEntryDate(draft.date)} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <>
          {event.note && <p className="whitespace-pre-wrap text-muted-foreground">{event.note}</p>}
          <p className="text-xs text-muted-foreground">{scheduledLabel(effectiveDate(event))} · {event.source}</p>
        </>
      )}
    </li>
  )
}
