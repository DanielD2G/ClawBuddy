import { useState } from 'react'
import { Settings, Check, AlertCircle } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  useWorkspaceCapabilities,
  useEnableCapability,
  useDisableCapability,
  useUpdateCapabilityConfig,
  type Capability,
} from '@/hooks/use-capabilities'
import { CapabilityConfigDialog } from './capability-config-dialog'
import type { ConfigFieldDefinition } from '@/types/capability-config'

interface WorkspaceCapabilitiesProps {
  workspaceId: string
}

export function WorkspaceCapabilities({ workspaceId }: WorkspaceCapabilitiesProps) {
  const { data: capabilities, isLoading } = useWorkspaceCapabilities(workspaceId)
  const enableMutation = useEnableCapability(workspaceId)
  const disableMutation = useDisableCapability(workspaceId)
  const updateConfigMutation = useUpdateCapabilityConfig(workspaceId)

  const [configDialog, setConfigDialog] = useState<{
    capability: Capability
    mode: 'enable' | 'edit'
  } | null>(null)

  if (isLoading) return null

  function handleToggle(cap: Capability) {
    if (cap.enabled) {
      disableMutation.mutate(cap.id)
    } else {
      const hasRequiredConfig = cap.configSchema?.some((f) => f.required)
      if (hasRequiredConfig) {
        setConfigDialog({ capability: cap, mode: 'enable' })
      } else {
        enableMutation.mutate({ slug: cap.slug })
      }
    }
  }

  function handleConfigSubmit(config: Record<string, unknown>) {
    if (!configDialog) return

    const { capability, mode } = configDialog

    if (mode === 'enable') {
      enableMutation.mutate(
        { slug: capability.slug, config },
        { onSuccess: () => setConfigDialog(null) },
      )
    } else {
      updateConfigMutation.mutate(
        { capabilityId: capability.id, config },
        { onSuccess: () => setConfigDialog(null) },
      )
    }
  }

  // Group by category
  const grouped = (capabilities ?? []).reduce(
    (acc, cap) => {
      const cat = cap.category || 'general'
      if (!acc[cat]) acc[cat] = []
      acc[cat].push(cap)
      return acc
    },
    {} as Record<string, Capability[]>,
  )

  const categoryLabels: Record<string, string> = {
    general: 'General',
    builtin: 'Built-in',
    languages: 'Languages',
    cloud: 'Cloud',
    devops: 'DevOps',
  }

  return (
    <div className="flex flex-col gap-6">
      {Object.entries(grouped).map(([category, caps]) => (
        <div key={category} className="flex flex-col gap-3">
          <h3 className="text-sm font-medium text-muted-foreground">
            {categoryLabels[category] ?? category}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {caps.map((cap) => {
              const hasConfig = cap.configSchema && cap.configSchema.length > 0
              const hasRequiredConfig = cap.configSchema?.some((f) => f.required)
              const isConfigured = cap.enabled && cap.config !== null

              return (
                <Card key={cap.id} size="sm">
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex flex-col gap-1">
                        <CardTitle className="text-sm">{cap.name}</CardTitle>
                        <CardDescription className="text-xs">
                          {cap.description}
                        </CardDescription>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {cap.enabled && hasConfig && (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() =>
                              setConfigDialog({ capability: cap, mode: 'edit' })
                            }
                          >
                            <Settings className="size-3.5" />
                          </Button>
                        )}
                        <Button
                          variant={cap.enabled ? 'secondary' : 'outline'}
                          size="xs"
                          onClick={() => handleToggle(cap)}
                          disabled={
                            enableMutation.isPending || disableMutation.isPending
                          }
                        >
                          {cap.enabled ? 'Disable' : 'Enable'}
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  {cap.enabled && hasConfig && (
                    <CardContent className="pt-0">
                      {isConfigured ? (
                        <Badge variant="secondary" className="text-xs">
                          <Check className="size-3" />
                          Configured
                        </Badge>
                      ) : hasRequiredConfig ? (
                        <Badge variant="destructive" className="text-xs">
                          <AlertCircle className="size-3" />
                          Config required
                        </Badge>
                      ) : null}
                    </CardContent>
                  )}
                </Card>
              )
            })}
          </div>
        </div>
      ))}

      {configDialog && (
        <CapabilityConfigDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfigDialog(null)
          }}
          capabilityName={configDialog.capability.name}
          schema={configDialog.capability.configSchema as ConfigFieldDefinition[]}
          initialValues={
            configDialog.mode === 'edit'
              ? (configDialog.capability.config ?? undefined)
              : undefined
          }
          onSubmit={handleConfigSubmit}
          isLoading={
            enableMutation.isPending || updateConfigMutation.isPending
          }
        />
      )}
    </div>
  )
}
