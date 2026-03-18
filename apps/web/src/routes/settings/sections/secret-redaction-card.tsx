import { isSecretRedactionEnabled, mergeWorkspaceSettings } from '@agentbuddy/shared'
import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useUpdateWorkspace } from '@/hooks/use-workspaces'
import { useActiveWorkspace } from '@/providers/workspace-provider'

export function SecretRedactionCard() {
  const { activeWorkspace, activeWorkspaceId } = useActiveWorkspace()
  const updateWorkspace = useUpdateWorkspace()

  const isEnabled = isSecretRedactionEnabled(activeWorkspace?.settings)

  const handleToggle = (checked: boolean) => {
    if (!activeWorkspaceId) return

    updateWorkspace.mutate(
      {
        id: activeWorkspaceId,
        settings: mergeWorkspaceSettings(
          activeWorkspace?.settings,
          { secretRedactionEnabled: checked },
        ) ?? { secretRedactionEnabled: checked },
      },
      {
        onSuccess: () => {
          toast.success(checked ? 'Secret redaction enabled' : 'Secret redaction disabled')
        },
        onError: (error) => {
          toast.error(error instanceof Error ? error.message : 'Failed to update secret redaction')
        },
      },
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-5" />
            <div>
              <CardTitle>Secret Redaction</CardTitle>
              <CardDescription>
                Mask secrets in agent responses, tool outputs, events, logs, and stored chat history for this workspace.
              </CardDescription>
            </div>
          </div>
          <Switch
            checked={isEnabled}
            disabled={!activeWorkspaceId || updateWorkspace.isPending}
            onCheckedChange={handleToggle}
          />
        </div>
      </CardHeader>

      {!isEnabled && (
        <CardContent className="pt-0">
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p className="text-sm text-destructive/90">
              Disabling this exposes raw secrets to the agent, UI, SSE events, database records, approvals, and debug logs in this workspace.
            </p>
          </div>
        </CardContent>
      )}
    </Card>
  )
}
