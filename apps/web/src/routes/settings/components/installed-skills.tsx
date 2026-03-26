import { useState, useRef, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
  Braces,
  Puzzle,
  Trash2,
  Upload,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
} from 'lucide-react'

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

export function InstalledSkills({
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
        // No installation script -- simple upload
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
