import { useEffect } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'
import { useWorkspace } from '@/hooks/use-workspaces'
import { FileExplorer } from '@/components/explorer/file-explorer'

export function WorkspacePage() {
  const { id } = useParams<{ id: string }>()
  const { data: workspace, isLoading } = useWorkspace(id!)
  const [searchParams, setSearchParams] = useSearchParams()

  useEffect(() => {
    const oauth = searchParams.get('oauth')
    if (oauth === 'success') {
      toast.success('Google account connected successfully')
      searchParams.delete('oauth')
      setSearchParams(searchParams, { replace: true })
    }
  }, [searchParams, setSearchParams])

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        {workspace?.color && (
          <span
            className="inline-block size-4 shrink-0 rounded-full"
            style={{ backgroundColor: workspace.color }}
          />
        )}
        <h1 className="text-2xl font-bold">{workspace?.name}</h1>
      </div>

      <FileExplorer workspaceId={id!} workspaceName={workspace?.name ?? ''} />
    </div>
  )
}
