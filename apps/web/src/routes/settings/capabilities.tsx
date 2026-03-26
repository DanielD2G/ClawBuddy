import { useState, useRef, useCallback, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type { Workspace } from '@/hooks/use-workspaces'
import { useActiveWorkspace } from '@/providers/workspace-provider'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { useSearchParams } from 'react-router-dom'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { CATEGORY_LABELS } from '@/constants'
import { CapabilityCard, type WorkspaceCapability } from './components/capability-card'
import { InstalledSkills } from './components/installed-skills'

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
