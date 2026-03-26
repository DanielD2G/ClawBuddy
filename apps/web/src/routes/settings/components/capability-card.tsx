import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { useActiveWorkspace } from '@/providers/workspace-provider'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { CapabilityConfigDialog } from '@/components/capabilities/capability-config-dialog'
import type { ConfigFieldDefinition } from '@/types/capability-config'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  Terminal,
  Code,
  FolderOpen,
  Cloud,
  Container,
  Box,
  FileSearch,
  Puzzle,
  Settings,
  Mail,
  Clock,
  LogIn,
  Unplug,
  Info,
} from 'lucide-react'

const ICON_MAP: Record<string, React.ElementType> = {
  Terminal,
  Code,
  FolderOpen,
  Cloud,
  Container,
  Box,
  FileSearch,
  Puzzle,
  Mail,
  Clock,
}

export interface WorkspaceCapability {
  id: string
  slug: string
  name: string
  description: string
  icon: string | null
  category: string
  version: string
  builtin: boolean
  dockerImage: string | null
  packages: string[]
  networkAccess: boolean
  toolDefinitions: unknown
  systemPrompt: string
  configSchema: ConfigFieldDefinition[] | null
  authType: string | null
  enabled: boolean
  alwaysOn: boolean
  config: Record<string, unknown> | null
  workspaceCapabilityId: string | null
}

export function CapabilityCard({
  capability,
  googleOAuthConfigured,
  onCapabilityToggled,
}: {
  capability: WorkspaceCapability
  googleOAuthConfigured: boolean
  onCapabilityToggled: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const queryClient = useQueryClient()
  const { activeWorkspaceId } = useActiveWorkspace()
  const Icon = ICON_MAP[capability.icon ?? ''] ?? Puzzle

  const isOAuth = capability.authType === 'oauth-google'
  const isOAuthBlocked = isOAuth && !googleOAuthConfigured
  const hasConfig = capability.configSchema && capability.configSchema.length > 0
  const isConfigured =
    capability.enabled && capability.config && Object.keys(capability.config).length > 0
  const oauthEmail = isOAuth && capability.config?.email ? String(capability.config.email) : null

  const toggleMutation = useMutation({
    mutationFn: (data: { enabled: boolean; config?: Record<string, unknown> }) =>
      apiClient.put(`/workspaces/${activeWorkspaceId}/capabilities/${capability.slug}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-capabilities', activeWorkspaceId] })
      onCapabilityToggled()
    },
  })

  const configMutation = useMutation({
    mutationFn: (config: Record<string, unknown>) =>
      apiClient.patch(`/workspaces/${activeWorkspaceId}/capabilities/${capability.id}`, { config }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-capabilities', activeWorkspaceId] })
      setConfigOpen(false)
      onCapabilityToggled()
    },
  })

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/oauth/google/disconnect', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ workspaceId: activeWorkspaceId, capabilitySlug: capability.slug }),
      })
      if (!res.ok) throw new Error('Failed to disconnect')
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['workspace-capabilities', activeWorkspaceId] }),
  })

  const handleToggle = (checked: boolean) => {
    if (checked && isOAuth && !oauthEmail) {
      // For OAuth capabilities, redirect to OAuth flow instead of toggling
      window.location.href = `/api/oauth/google/authorize?workspaceId=${activeWorkspaceId}&capabilitySlug=${capability.slug}`
      return
    }
    if (checked && hasConfig && !isConfigured && !isOAuth) {
      setConfigOpen(true)
      return
    }
    toggleMutation.mutate({ enabled: checked })
  }

  const handleConfigSubmit = (config: Record<string, unknown>) => {
    if (!capability.enabled) {
      toggleMutation.mutate({ enabled: true, config })
      setConfigOpen(false)
    } else {
      configMutation.mutate(config)
    }
  }

  const handleDisconnect = () => {
    if (
      confirm('Disconnect Google account? This will remove credentials and disable the capability.')
    ) {
      disconnectMutation.mutate()
    }
  }

  return (
    <>
      <Card
        className={`flex flex-col ${capability.enabled ? 'ring-1 ring-brand/30' : ''} ${isOAuthBlocked ? 'opacity-60' : ''}`}
      >
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2">
              <div
                className={`flex size-8 items-center justify-center rounded-md shrink-0 ${capability.enabled ? 'bg-brand/10' : 'bg-muted'}`}
              >
                <Icon className="size-4" />
              </div>
              <div className="min-w-0">
                <CardTitle className="text-sm">{capability.name}</CardTitle>
                <code className="text-xs text-muted-foreground">@{capability.slug}</code>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {capability.networkAccess && (
                <Badge variant="outline" className="text-[10px]">
                  Network
                </Badge>
              )}
              {!isOAuth && (
                <div className="relative group">
                  <Switch
                    checked={capability.alwaysOn || capability.enabled}
                    onCheckedChange={handleToggle}
                    disabled={capability.alwaysOn || toggleMutation.isPending}
                  />
                  {capability.alwaysOn && (
                    <span className="absolute -bottom-6 right-0 text-[10px] text-muted-foreground bg-popover border rounded px-1.5 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-10">
                      Always on
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0 flex flex-col flex-1">
          <CardDescription className="text-xs line-clamp-2 mb-auto">
            {capability.description}
          </CardDescription>

          {/* Blocked OAuth message */}
          {isOAuthBlocked && (
            <div className="flex items-start gap-2 rounded-md border border-muted bg-muted/30 p-2 mt-3">
              <Info className="size-3.5 text-muted-foreground mt-0.5 shrink-0" />
              <p className="text-[11px] text-muted-foreground">
                Add <code className="bg-muted px-1 rounded">GOOGLE_CLIENT_ID</code> and{' '}
                <code className="bg-muted px-1 rounded">GOOGLE_CLIENT_SECRET</code> to your
                environment to enable this capability.
              </p>
            </div>
          )}

          {!isOAuthBlocked && (
            <div className="mt-3 space-y-2">
              {/* Status badges */}
              <div className="flex items-center flex-wrap gap-1.5 text-xs">
                {capability.enabled &&
                  (!isOAuth && hasConfig && !isConfigured ? (
                    <Badge variant="destructive" className="text-[10px]">
                      Config required
                    </Badge>
                  ) : (
                    <Badge variant="default" className="text-[10px] bg-brand">
                      Enabled
                    </Badge>
                  ))}
                {oauthEmail && (
                  <Badge variant="secondary" className="text-[10px]">
                    {oauthEmail}
                  </Badge>
                )}
              </div>

              {/* Actions row */}
              <div className="flex items-center gap-2 pt-1">
                {/* OAuth connect/disconnect */}
                {isOAuth &&
                  (oauthEmail ? (
                    <Button
                      variant="outline"
                      onClick={handleDisconnect}
                      disabled={disconnectMutation.isPending}
                    >
                      <Unplug className="size-4 mr-1" />
                      Disconnect
                    </Button>
                  ) : (
                    <Button
                      onClick={() => {
                        window.location.href = `/api/oauth/google/authorize?workspaceId=${activeWorkspaceId}&capabilitySlug=${capability.slug}`
                      }}
                    >
                      <LogIn className="size-4 mr-1" />
                      Connect Google Account
                    </Button>
                  ))}
                {!isOAuth && hasConfig && capability.enabled && (
                  <Button variant="outline" onClick={() => setConfigOpen(true)}>
                    <Settings className="size-4 mr-1" />
                    Settings
                  </Button>
                )}
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors ml-auto"
                >
                  <Info className="size-3" />
                  Details
                </button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Details dialog */}
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div
                className={`flex size-6 items-center justify-center rounded-md ${capability.enabled ? 'bg-brand/10' : 'bg-muted'}`}
              >
                <Icon className="size-3.5" />
              </div>
              {capability.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <p className="text-muted-foreground">{capability.description}</p>
            <div>
              <span className="font-medium text-xs uppercase tracking-wide text-muted-foreground">
                Tools
              </span>
              <div className="mt-2 space-y-1.5">
                {(capability.toolDefinitions as Array<{ name: string; description: string }>).map(
                  (t) => (
                    <div key={t.name} className="flex items-start gap-2">
                      <code className="bg-muted px-1.5 py-0.5 rounded text-xs shrink-0">
                        {t.name}
                      </code>
                      <span className="text-xs text-muted-foreground">{t.description}</span>
                    </div>
                  ),
                )}
              </div>
            </div>
            {capability.packages.length > 0 && (
              <div>
                <span className="font-medium text-xs uppercase tracking-wide text-muted-foreground">
                  Packages
                </span>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {capability.packages.map((pkg) => (
                    <code key={pkg} className="bg-muted px-1.5 py-0.5 rounded text-xs">
                      {pkg}
                    </code>
                  ))}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {hasConfig && !isOAuth && (
        <CapabilityConfigDialog
          open={configOpen}
          onOpenChange={setConfigOpen}
          capabilityName={capability.name}
          schema={capability.configSchema!}
          initialValues={capability.config ?? undefined}
          onSubmit={handleConfigSubmit}
          isLoading={configMutation.isPending || toggleMutation.isPending}
        />
      )}
    </>
  )
}
