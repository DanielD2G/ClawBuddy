import { useState, useRef, useCallback, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type { Workspace } from '@/hooks/use-workspaces'
import { useActiveWorkspace } from '@/providers/workspace-provider'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { CapabilityConfigDialog } from '@/components/capabilities/capability-config-dialog'
import type { ConfigFieldDefinition } from '@/types/capability-config'
import { toast } from 'sonner'
import { useSearchParams } from 'react-router-dom'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
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
  Trash2,
  Upload,
  Braces,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  Mail,
  Clock,
  LogIn,
  Unplug,
  Info,
} from 'lucide-react'
import { CATEGORY_LABELS } from '@/constants'

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

interface WorkspaceCapability {
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

interface Skill {
  id: string
  slug: string
  name: string
  description: string
  version: string
  icon: string | null
  category: string
  skillType: string | null
  installationScript: string | null
  enabled: boolean
  source: string
  createdAt: string
}

const TYPE_ICONS: Record<string, typeof Terminal> = {
  bash: Terminal,
  python: Code,
  js: Braces,
}

const TYPE_COLORS: Record<string, string> = {
  bash: 'bg-green-500/10 text-green-500',
  python: 'bg-blue-500/10 text-blue-500',
  js: 'bg-yellow-500/10 text-yellow-500',
}

export function CapabilitiesSettingsPage() {
  const { activeWorkspaceId } = useActiveWorkspace()
  const [rebuildState, setRebuildState] = useState<{
    status: 'idle' | 'building' | 'success' | 'error'
    logs: string[]
    error?: string
  }>({ status: 'idle', logs: [] })
  const [showRebuildDialog, setShowRebuildDialog] = useState(false)
  const rebuildLogsRef = useRef<HTMLDivElement>(null)

  const triggerRebuild = useCallback(async () => {
    if (!activeWorkspaceId) return
    setRebuildState({ status: 'building', logs: [] })
    setShowRebuildDialog(true)

    try {
      const res = await fetch('/api/skills/rebuild-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ workspaceId: activeWorkspaceId }),
      })

      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      if (!reader) {
        setRebuildState({ status: 'error', logs: [], error: 'No response stream' })
        return
      }

      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data:')) {
            const data = line.slice(5).trim()
            if (data) {
              try {
                const parsed = JSON.parse(data)
                if (parsed.success === true) {
                  setRebuildState((s) => ({
                    ...s,
                    status: 'success',
                    logs: [...s.logs, `Image built: ${parsed.image}`],
                  }))
                } else if (parsed.success === false) {
                  setRebuildState((s) => ({
                    ...s,
                    status: 'error',
                    error: parsed.error,
                  }))
                }
              } catch {
                setRebuildState((s) => ({
                  ...s,
                  logs: [...s.logs, data],
                }))
              }
            }
          }
        }
      }
    } catch (err) {
      setRebuildState({
        status: 'error',
        logs: [],
        error: err instanceof Error ? err.message : 'Rebuild failed',
      })
    }
  }, [activeWorkspaceId])

  useEffect(() => {
    if (rebuildLogsRef.current) {
      rebuildLogsRef.current.scrollTop = rebuildLogsRef.current.scrollHeight
    }
  }, [rebuildState.logs])

  const closeRebuildDialog = () => {
    setShowRebuildDialog(false)
    setRebuildState({ status: 'idle', logs: [] })
  }

  return (
    <div className="space-y-8">
      <CapabilitiesGrid onCapabilityToggled={triggerRebuild} />

      <div className="border-t pt-8">
        <InstalledSkills onRebuild={triggerRebuild} rebuildStatus={rebuildState.status} />
      </div>

      {/* Rebuild Progress Dialog */}
      <Dialog open={showRebuildDialog} onOpenChange={closeRebuildDialog}>
        <DialogContent className="max-w-3xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {rebuildState.status === 'building' && (
                <>
                  <Loader2 className="size-5 animate-spin text-blue-500" />
                  Building Image...
                </>
              )}
              {rebuildState.status === 'success' && (
                <>
                  <CheckCircle2 className="size-5 text-green-500" />
                  Build Complete
                </>
              )}
              {rebuildState.status === 'error' && (
                <>
                  <XCircle className="size-5 text-destructive" />
                  Build Failed
                </>
              )}
            </DialogTitle>
          </DialogHeader>

          {rebuildState.error && <p className="text-sm text-destructive">{rebuildState.error}</p>}

          {rebuildState.logs.length > 0 && (
            <div
              ref={rebuildLogsRef}
              className="h-96 overflow-auto rounded-md border bg-muted/50 p-3"
            >
              <pre className="text-xs font-mono whitespace-pre-wrap">
                {rebuildState.logs.join('\n')}
              </pre>
            </div>
          )}

          <DialogFooter>
            <Button
              variant={rebuildState.status === 'error' ? 'destructive' : 'default'}
              onClick={closeRebuildDialog}
              disabled={rebuildState.status === 'building'}
            >
              {rebuildState.status === 'building' ? 'Please wait...' : 'Close'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function CapabilitiesGrid({ onCapabilityToggled }: { onCapabilityToggled: () => void }) {
  const { activeWorkspaceId, setActiveWorkspace } = useActiveWorkspace()
  const [searchParams, setSearchParams] = useSearchParams()

  // Handle OAuth callback query params
  useEffect(() => {
    const oauthStatus = searchParams.get('oauth')
    const callbackWorkspaceId = searchParams.get('workspaceId')
    if (!oauthStatus) return

    let cancelled = false

    const syncWorkspace = async () => {
      if (callbackWorkspaceId && callbackWorkspaceId !== activeWorkspaceId) {
        try {
          const workspace = await apiClient.get<Workspace>(`/workspaces/${callbackWorkspaceId}`)
          if (!cancelled) {
            setActiveWorkspace(workspace)
          }
        } catch {
          // If lookup fails, still show the OAuth result and clean the URL.
        }
      }

      if (oauthStatus === 'success') {
        toast.success('Google account connected successfully')
      } else if (oauthStatus === 'error') {
        const message = searchParams.get('message') || 'OAuth failed'
        toast.error(`Google OAuth failed: ${message}`)
      }

      searchParams.delete('oauth')
      searchParams.delete('message')
      searchParams.delete('workspaceId')
      setSearchParams(searchParams, { replace: true })
    }

    syncWorkspace()

    return () => {
      cancelled = true
    }
  }, [activeWorkspaceId, searchParams, setActiveWorkspace, setSearchParams])

  const { data: capabilities, isLoading } = useQuery({
    queryKey: ['workspace-capabilities', activeWorkspaceId],
    queryFn: () =>
      apiClient.get<WorkspaceCapability[]>(`/workspaces/${activeWorkspaceId}/capabilities`),
    enabled: !!activeWorkspaceId,
  })

  const { data: googleOAuthConfig } = useQuery({
    queryKey: ['google-oauth-config'],
    queryFn: () => apiClient.get<{ configured: boolean }>('/global-settings/google-oauth'),
  })
  const googleOAuthConfigured = googleOAuthConfig?.configured ?? false

  if (!activeWorkspaceId) {
    return <div className="text-muted-foreground">Select a workspace to manage capabilities.</div>
  }

  if (isLoading) {
    return <div className="text-muted-foreground">Loading capabilities...</div>
  }

  // Group by category
  const grouped = (capabilities ?? []).reduce(
    (acc, cap) => {
      const cat = cap.category
      if (!acc[cat]) acc[cat] = []
      acc[cat].push(cap)
      return acc
    },
    {} as Record<string, WorkspaceCapability[]>,
  )

  return (
    <div className="space-y-6">
      {Object.entries(grouped).map(([category, caps]) => (
        <div key={category}>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            {CATEGORY_LABELS[category] ?? category}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {caps.map((cap) => (
              <CapabilityCard
                key={cap.id}
                capability={cap}
                googleOAuthConfigured={googleOAuthConfigured}
                onCapabilityToggled={onCapabilityToggled}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function CapabilityCard({
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

function InstalledSkills({
  onRebuild,
  rebuildStatus,
}: {
  onRebuild: () => void
  rebuildStatus: string
}) {
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploadState, setUploadState] = useState<{
    status: 'idle' | 'uploading' | 'building' | 'success' | 'error'
    logs: string[]
    error?: string
  }>({ status: 'idle', logs: [] })
  const [showUploadDialog, setShowUploadDialog] = useState(false)

  const { data: skills = [], isLoading } = useQuery<Skill[]>({
    queryKey: ['admin-skills'],
    queryFn: () => apiClient.get('/skills'),
  })

  const deleteMutation = useMutation({
    mutationFn: (slug: string) => apiClient.delete(`/skills/${slug}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-skills'] }),
  })

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return

      // Reset input
      if (fileInputRef.current) fileInputRef.current.value = ''

      let skillData: Record<string, unknown>
      try {
        const text = await file.text()
        skillData = JSON.parse(text)
      } catch {
        setUploadState({ status: 'error', logs: [], error: 'Invalid JSON file' })
        setShowUploadDialog(true)
        return
      }

      setUploadState({ status: 'uploading', logs: [] })
      setShowUploadDialog(true)

      // If skill has installation, use SSE for streaming logs
      if (skillData.installation) {
        setUploadState((s) => ({ ...s, status: 'building' }))

        try {
          const res = await fetch('/api/skills/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(skillData),
          })

          if (!res.ok && !res.headers.get('content-type')?.includes('text/event-stream')) {
            const err = await res.json().catch(() => ({ error: 'Upload failed' }))
            setUploadState({
              status: 'error',
              logs: err.logs ? err.logs.split('\n') : [],
              error: err.error || 'Upload failed',
            })
            return
          }

          const reader = res.body?.getReader()
          const decoder = new TextDecoder()
          if (!reader) {
            setUploadState({ status: 'error', logs: [], error: 'No response stream' })
            return
          }

          let buffer = ''
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
              if (line.startsWith('data:')) {
                const data = line.slice(5).trim()

                // Check for event type from previous line
                if (data) {
                  try {
                    const parsed = JSON.parse(data)
                    if (parsed.success === true) {
                      setUploadState((s) => ({
                        ...s,
                        status: 'success',
                        logs: [...s.logs, 'Skill installed successfully!'],
                      }))
                      queryClient.invalidateQueries({ queryKey: ['admin-skills'] })
                    } else if (parsed.success === false) {
                      setUploadState((s) => ({
                        ...s,
                        status: 'error',
                        error: parsed.error,
                        logs: parsed.logs ? [...s.logs, ...parsed.logs.split('\n')] : s.logs,
                      }))
                    }
                  } catch {
                    // Plain text log line
                    setUploadState((s) => ({
                      ...s,
                      logs: [...s.logs, data],
                    }))
                  }
                }
              }
            }
          }
        } catch (err) {
          setUploadState({
            status: 'error',
            logs: [],
            error: err instanceof Error ? err.message : 'Upload failed',
          })
        }
      } else {
        // No installation script — simple upload
        try {
          await apiClient.post('/skills/upload', skillData)
          setUploadState({ status: 'success', logs: ['Skill installed successfully!'] })
          queryClient.invalidateQueries({ queryKey: ['admin-skills'] })
        } catch (err) {
          setUploadState({
            status: 'error',
            logs: [],
            error: err instanceof Error ? err.message : 'Upload failed',
          })
        }
      }
    },
    [queryClient],
  )

  const closeDialog = () => {
    setShowUploadDialog(false)
    setUploadState({ status: 'idle', logs: [] })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Installed Skills</h2>
          <p className="text-sm text-muted-foreground">
            Install and manage skill plugins for the sandbox environment.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onRebuild}
            disabled={rebuildStatus === 'building'}
          >
            {rebuildStatus === 'building' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Rebuild Image
          </Button>
          <Button size="sm" onClick={() => fileInputRef.current?.click()}>
            <Upload className="size-4" />
            Upload Skill
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".skill,.json"
            className="hidden"
            onChange={handleFileSelect}
          />
        </div>
      </div>

      {/* Skills Grid */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader className="pb-3">
                <div className="h-5 w-32 bg-muted rounded" />
              </CardHeader>
              <CardContent>
                <div className="h-4 w-full bg-muted rounded" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : skills.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Puzzle className="size-12 text-muted-foreground/50 mb-4" />
            <p className="text-muted-foreground text-center">
              No skills installed yet. Upload a <code>.skill</code> file to get started.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {skills.map((skill) => {
            const TypeIcon = TYPE_ICONS[skill.skillType ?? ''] ?? Terminal
            const typeColor = TYPE_COLORS[skill.skillType ?? ''] ?? 'bg-muted text-muted-foreground'

            return (
              <Card key={skill.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-base">{skill.name}</CardTitle>
                      <Badge variant="outline" className={typeColor}>
                        <TypeIcon className="size-3 mr-1" />
                        {skill.skillType}
                      </Badge>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        if (confirm(`Delete skill "${skill.name}"?`)) {
                          deleteMutation.mutate(skill.slug)
                        }
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-sm text-muted-foreground line-clamp-2">{skill.description}</p>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="secondary" className="text-[10px]">
                      v{skill.version}
                    </Badge>
                    <Badge variant="secondary" className="text-[10px]">
                      {skill.category}
                    </Badge>
                    {skill.installationScript && (
                      <Badge variant="secondary" className="text-[10px]">
                        has installation
                      </Badge>
                    )}
                    {skill.enabled && (
                      <Badge className="text-[10px] bg-green-500/10 text-green-500">enabled</Badge>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Upload Progress Dialog (skill file uploads only) */}
      <Dialog open={showUploadDialog} onOpenChange={closeDialog}>
        <DialogContent className="max-w-3xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {uploadState.status === 'building' && (
                <>
                  <Loader2 className="size-5 animate-spin text-blue-500" />
                  Building Skill...
                </>
              )}
              {uploadState.status === 'uploading' && (
                <>
                  <Loader2 className="size-5 animate-spin" />
                  Uploading...
                </>
              )}
              {uploadState.status === 'success' && (
                <>
                  <CheckCircle2 className="size-5 text-green-500" />
                  Build Complete
                </>
              )}
              {uploadState.status === 'error' && (
                <>
                  <XCircle className="size-5 text-destructive" />
                  Build Failed
                </>
              )}
            </DialogTitle>
          </DialogHeader>

          {uploadState.error && <p className="text-sm text-destructive">{uploadState.error}</p>}

          {uploadState.logs.length > 0 && (
            <div className="h-96 overflow-auto rounded-md border bg-muted/50 p-3">
              <pre className="text-xs font-mono whitespace-pre-wrap">
                {uploadState.logs.join('\n')}
              </pre>
            </div>
          )}

          <DialogFooter>
            <Button
              variant={uploadState.status === 'error' ? 'destructive' : 'default'}
              onClick={closeDialog}
              disabled={uploadState.status === 'building' || uploadState.status === 'uploading'}
            >
              {uploadState.status === 'building' || uploadState.status === 'uploading'
                ? 'Please wait...'
                : 'Close'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
