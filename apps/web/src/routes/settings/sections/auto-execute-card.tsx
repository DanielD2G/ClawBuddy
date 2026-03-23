import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { useActiveWorkspace } from '@/providers/workspace-provider'
import { useUpdateWorkspaceSettings } from '@/hooks/use-workspace-settings'
import { Zap, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'

export function AutoExecuteCard() {
  const { activeWorkspace, activeWorkspaceId } = useActiveWorkspace()
  const updateWorkspace = useUpdateWorkspaceSettings()
  const [showConfirm, setShowConfirm] = useState(false)
  const [confirmText, setConfirmText] = useState('')

  const isEnabled = activeWorkspace?.autoExecute ?? false

  const handleToggle = (checked: boolean) => {
    if (!activeWorkspaceId) return

    if (checked) {
      setShowConfirm(true)
      setConfirmText('')
    } else {
      updateWorkspace.mutate(
        { id: activeWorkspaceId!, autoExecute: false },
        { onSuccess: () => toast.success('Auto-execute disabled') },
      )
    }
  }

  const handleConfirm = () => {
    updateWorkspace.mutate(
      { id: activeWorkspaceId!, autoExecute: true },
      {
        onSuccess: () => {
          toast.success('Auto-execute enabled')
          setShowConfirm(false)
        },
      },
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap className="size-5" />
            <div>
              <CardTitle>Auto-Execute Mode</CardTitle>
              <CardDescription>
                When enabled, all tool calls execute automatically without approval.
              </CardDescription>
            </div>
          </div>
          <Switch
            checked={isEnabled}
            onCheckedChange={handleToggle}
            disabled={!activeWorkspaceId}
          />
        </div>
      </CardHeader>

      {isEnabled && (
        <CardContent className="pt-0">
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
            <AlertTriangle className="size-4 text-amber-500 mt-0.5 shrink-0" />
            <p className="text-sm text-amber-600 dark:text-amber-400">
              All commands (bash, python, file writes, etc.) run without confirmation in this
              workspace — including destructive operations.
            </p>
          </div>
        </CardContent>
      )}

      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-amber-500" />
              Enable Auto-Execute Mode
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              This will allow all tool calls — including bash commands, Python scripts, and file
              operations — to execute <strong>without asking for your approval</strong>.
            </p>
            <p className="text-sm text-muted-foreground">
              This includes potentially destructive operations. Only enable this for trusted
              workspaces.
            </p>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Type <code className="rounded bg-muted px-1.5 py-0.5 text-xs">ENABLE</code> to
                confirm
              </label>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="ENABLE"
                className="w-full rounded-md border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={confirmText !== 'ENABLE' || updateWorkspace.isPending}
              onClick={handleConfirm}
            >
              Enable
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
