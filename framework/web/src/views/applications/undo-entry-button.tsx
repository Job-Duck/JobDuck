import { useState } from 'react'
import { Undo2Icon } from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import type { SaveResult } from '@/lib/api'
import { statusLabel } from '@/lib/format'
import { revertsTo } from '@/lib/status-entries'
import type { ApplicationEvent } from '@/lib/types'

interface UndoEntryButtonProps {
  event: ApplicationEvent
  label: string
  onUndo: () => Promise<SaveResult>
}

export function UndoEntryButton({ event, label, onUndo }: UndoEntryButtonProps) {
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Undo entry" onClick={() => setConfirming(true)}>
        <Undo2Icon />
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Undo This Entry?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="capitalize">{label}</span> is removed and the status goes back to {statusLabel(revertsTo(event) ?? '')}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => { void onUndo().then((result) => { if (result !== 'failed') setConfirming(false) }) }}
            >
              Undo
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
