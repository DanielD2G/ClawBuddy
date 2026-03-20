import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { Globe, Loader2, CheckCircle2, XCircle, Trash2, ChevronsUpDown, Check } from 'lucide-react'
import { POLL_BROWSER_HEALTH_MS, POLL_BROWSER_SESSIONS_MS } from '@/constants'

interface BrowserConfig {
  url: string
  hasApiKey: boolean
  browser: string
  browserModel: string | null
}

interface BrowserSession {
  chatSessionId: string
  lastActivityAt: string
}

export function BrowserSettingsPage() {
  const queryClient = useQueryClient()
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)

  const { data: config, isLoading } = useQuery({
    queryKey: ['browser-config'],
    queryFn: () => apiClient.get<BrowserConfig>('/browser/config'),
  })

  const { data: health } = useQuery({
    queryKey: ['browser-health'],
    queryFn: () => apiClient.get<{ healthy: boolean }>('/browser/health'),
    refetchInterval: POLL_BROWSER_HEALTH_MS,
  })

  const { data: sessionsData } = useQuery({
    queryKey: ['browser-sessions'],
    queryFn: () => apiClient.get<{ sessions: BrowserSession[] }>('/browser/sessions'),
    refetchInterval: POLL_BROWSER_SESSIONS_MS,
  })

  const updateConfig = useMutation({
    mutationFn: (data: Record<string, unknown>) => apiClient.patch('/browser/config', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['browser-config'] })
      queryClient.invalidateQueries({ queryKey: ['browser-health'] })
    },
  })

  const closeSession = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/browser/sessions/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['browser-sessions'] })
    },
  })

  const testConnection = useMutation({
    mutationFn: () => apiClient.get<{ healthy: boolean }>('/browser/health'),
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const sessions = sessionsData?.sessions ?? []

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Browser Automation</h2>
        <p className="text-muted-foreground">
          Configure BrowserGrid for web page browsing and interaction.
        </p>
      </div>

      {/* Status */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Globe className="h-5 w-5" />
              <CardTitle className="text-base">BrowserGrid Status</CardTitle>
            </div>
            <Badge variant={health?.healthy ? 'default' : 'secondary'}>
              {health?.healthy ? (
                <>
                  <CheckCircle2 className="mr-1 h-3 w-3" /> Connected
                </>
              ) : (
                <>
                  <XCircle className="mr-1 h-3 w-3" /> Disconnected
                </>
              )}
            </Badge>
          </div>
        </CardHeader>
      </Card>

      {/* Connection Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connection Settings</CardTitle>
          <CardDescription>
            Configure the URL and credentials for your BrowserGrid instance.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Grid URL */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Grid URL</label>
            <div className="flex gap-2">
              <Input
                defaultValue={config?.url ?? 'http://localhost:9090'}
                placeholder="http://localhost:9090"
                onBlur={(e) => {
                  if (e.target.value !== config?.url) {
                    updateConfig.mutate({ url: e.target.value })
                  }
                }}
              />
            </div>
          </div>

          {/* API Key */}
          <div className="space-y-2">
            <label className="text-sm font-medium">API Key (optional)</label>
            <div className="flex gap-2">
              <Input
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={config?.hasApiKey ? '••••••••' : 'No API key set'}
              />
              <Button variant="outline" size="sm" onClick={() => setShowApiKey(!showApiKey)}>
                {showApiKey ? 'Hide' : 'Show'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  updateConfig.mutate({ apiKey })
                  setApiKey('')
                }}
                disabled={!apiKey}
              >
                Save
              </Button>
              {config?.hasApiKey && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => updateConfig.mutate({ apiKey: '' })}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Browser Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Browser Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Browser Engine</label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex w-full items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm hover:bg-muted/70 dark:bg-muted/20 dark:hover:bg-muted/40">
                  <span>{config?.browser === 'firefox' ? 'Firefox' : config?.browser === 'camoufox' ? 'Camoufox (anti-detection)' : 'Chromium'}</span>
                  <ChevronsUpDown className="size-4 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {[
                  { value: 'chromium', label: 'Chromium' },
                  { value: 'firefox', label: 'Firefox' },
                  { value: 'camoufox', label: 'Camoufox (anti-detection)' },
                ].map((opt) => (
                  <DropdownMenuItem
                    key={opt.value}
                    onClick={() => updateConfig.mutate({ browser: opt.value })}
                    className="gap-2"
                  >
                    <span className="flex-1">{opt.label}</span>
                    {(config?.browser ?? 'chromium') === opt.value && <Check className="size-3.5" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Test Connection */}
          <Button
            variant="outline"
            onClick={() => testConnection.mutate()}
            disabled={testConnection.isPending}
          >
            {testConnection.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : testConnection.isSuccess ? (
              testConnection.data?.healthy ? (
                <CheckCircle2 className="mr-2 h-4 w-4 text-green-500" />
              ) : (
                <XCircle className="mr-2 h-4 w-4 text-red-500" />
              )
            ) : null}
            Test Connection
          </Button>
        </CardContent>
      </Card>

      {/* Active Sessions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active Sessions</CardTitle>
          <CardDescription>Browser sessions tied to active chat conversations.</CardDescription>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active browser sessions.</p>
          ) : (
            <div className="space-y-2">
              {sessions.map((s) => (
                <div
                  key={s.chatSessionId}
                  className="flex items-center justify-between rounded-md border p-3"
                >
                  <div>
                    <div className="text-sm font-medium font-mono">
                      {s.chatSessionId.slice(0, 12)}...
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Last activity: {new Date(s.lastActivityAt).toLocaleString()}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => closeSession.mutate(s.chatSessionId)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
