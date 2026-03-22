import { Palette } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useActiveWorkspace } from '@/providers/workspace-provider'
import { useUpdateWorkspaceSettings } from '@/hooks/use-workspace-settings'
import { WORKSPACE_COLORS } from '@/constants'

export function WorkspaceColorCard() {
  const { activeWorkspace, activeWorkspaceId } = useActiveWorkspace()
  const updateWorkspaceSettings = useUpdateWorkspaceSettings()

  const selectedColor = activeWorkspace?.color ?? WORKSPACE_COLORS[0]

  const handleSelect = (color: string) => {
    if (!activeWorkspaceId || color === activeWorkspace?.color) return

    updateWorkspaceSettings.mutate(
      { id: activeWorkspaceId, color },
      {
        onSuccess: () => toast.success('Workspace color updated'),
        onError: (error) => {
          toast.error(error instanceof Error ? error.message : 'Failed to update workspace color')
        },
      },
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Palette className="size-5" />
          Workspace Color
        </CardTitle>
        <CardDescription>
          Pick the accent color for the active workspace across the app.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!activeWorkspaceId ? (
          <p className="text-sm text-muted-foreground">Select a workspace to change its color.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {WORKSPACE_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => handleSelect(color)}
                disabled={updateWorkspaceSettings.isPending}
                className={`size-8 rounded-full transition-all ${
                  selectedColor === color
                    ? 'ring-2 ring-offset-2 ring-brand scale-110'
                    : 'hover:scale-105'
                }`}
                style={{ backgroundColor: color }}
                aria-label={`Select workspace color ${color}`}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
