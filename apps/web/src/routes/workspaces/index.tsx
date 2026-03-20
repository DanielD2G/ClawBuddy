import { useState, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Plus, FolderOpen, ArrowRight, Trash2, Download, Upload } from 'lucide-react'
import {
  useWorkspaces,
  useCreateWorkspace,
  useDeleteWorkspace,
  useExportWorkspace,
  useImportWorkspace,
  type Workspace,
} from '@/hooks/use-workspaces'
import { useActiveWorkspace } from '@/providers/workspace-provider'
import { toast } from 'sonner'
import { WORKSPACE_COLORS } from '@/constants'

export function WorkspacesPage() {
  const { data: workspaces, isLoading } = useWorkspaces()
  const createWorkspace = useCreateWorkspace()
  const deleteWorkspace = useDeleteWorkspace()
  const exportWorkspace = useExportWorkspace()
  const importWorkspace = useImportWorkspace()
  const { activeWorkspace, setActiveWorkspace } = useActiveWorkspace()
  const [open, setOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState(WORKSPACE_COLORS[0])
  const importFileRef = useRef<HTMLInputElement>(null)

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await createWorkspace.mutateAsync({ name, description, color })
      toast.success('Workspace created')
      setOpen(false)
      setName('')
      setDescription('')
      setColor(WORKSPACE_COLORS[0])
    } catch {
      toast.error('Failed to create workspace')
    }
  }

  const handleExport = (ws: Workspace) => {
    exportWorkspace.mutate(ws.id, {
      onSuccess: () => toast.success(`Workspace "${ws.name}" exported`),
      onError: () => toast.error('Failed to export workspace'),
    })
  }

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      await importWorkspace.mutateAsync(data)
      toast.success('Workspace imported successfully')
      setImportOpen(false)
    } catch {
      toast.error('Failed to import workspace — check that the file is valid')
    }
    // Reset file input
    if (importFileRef.current) importFileRef.current.value = ''
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold">Workspaces</h1>
        <div className="flex gap-2">
          <Dialog open={importOpen} onOpenChange={setImportOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">
                <Upload data-icon="inline-start" />
                Import
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Import Workspace</DialogTitle>
                <DialogDescription>
                  Import a workspace from a previously exported JSON file. A new workspace will be
                  created with the imported settings.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-4">
                <p className="text-sm text-muted-foreground">
                  Note: Telegram channels will be imported as disabled. You&apos;ll need to test and
                  enable them manually.
                </p>
                <input
                  ref={importFileRef}
                  type="file"
                  accept=".json"
                  onChange={handleImportFile}
                  className="block w-full text-sm file:mr-4 file:rounded-md file:border-0 file:bg-brand file:px-4 file:py-2 file:text-sm file:font-medium file:text-brand-foreground hover:file:bg-brand/90 file:cursor-pointer"
                />
                {importWorkspace.isPending && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Spinner className="size-4" /> Importing...
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setImportOpen(false)}>
                  Cancel
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="bg-brand text-brand-foreground hover:bg-brand/90">
                <Plus data-icon="inline-start" />
                New Workspace
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Workspace</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleCreate} className="flex flex-col gap-4">
                <Input
                  placeholder="Workspace name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
                <Input
                  placeholder="Description (optional)"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-muted-foreground">Color</label>
                  <div className="flex gap-2 flex-wrap">
                    {WORKSPACE_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setColor(c)}
                        className={`size-7 rounded-full transition-all ${
                          color === c
                            ? 'ring-2 ring-offset-2 ring-brand scale-110'
                            : 'hover:scale-105'
                        }`}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                </div>
                <Button
                  type="submit"
                  disabled={!name.trim() || createWorkspace.isPending}
                  className="bg-brand text-brand-foreground hover:bg-brand/90"
                >
                  {createWorkspace.isPending ? <Spinner data-icon="inline-start" /> : null}
                  Create
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-48" />
              </CardHeader>
            </Card>
          ))}
        </div>
      )}

      {!isLoading && workspaces?.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FolderOpen className="size-12 text-muted-foreground mb-4" />
          <h2 className="text-lg font-semibold">No workspaces yet</h2>
          <p className="text-muted-foreground mb-4">Create your first workspace to get started.</p>
        </div>
      )}

      {!isLoading && workspaces && workspaces.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {workspaces.map((ws: Workspace) => (
            <Card key={ws.id} className="group relative hover:border-brand/50 transition-colors">
              <Link to={`/workspaces/${ws.id}`} className="block">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    {ws.color && (
                      <span
                        className="inline-block size-3 shrink-0 rounded-full"
                        style={{ backgroundColor: ws.color }}
                      />
                    )}
                    {ws.name}
                  </CardTitle>
                  {ws.description && <CardDescription>{ws.description}</CardDescription>}
                </CardHeader>
                <CardContent className="flex justify-end">
                  <ArrowRight className="text-muted-foreground" />
                </CardContent>
              </Link>
              <div className="absolute right-3 top-3 flex gap-1 opacity-0 transition-all group-hover:opacity-100">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    handleExport(ws)
                  }}
                  className="rounded-md p-1.5 hover:text-brand"
                  title="Export workspace"
                >
                  <Download className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (
                      !confirm(
                        `Delete workspace "${ws.name}"? This will delete all documents and chat sessions in it.`,
                      )
                    )
                      return
                    // Switch to another workspace if deleting the active one
                    if (activeWorkspace?.id === ws.id) {
                      const other = workspaces?.find((w) => w.id !== ws.id)
                      setActiveWorkspace(other ?? null)
                    }
                    deleteWorkspace.mutate(ws.id, {
                      onSuccess: () => toast.success('Workspace deleted'),
                      onError: () => toast.error('Failed to delete workspace'),
                    })
                  }}
                  className="rounded-md p-1.5 hover:text-destructive"
                  title="Delete workspace"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
