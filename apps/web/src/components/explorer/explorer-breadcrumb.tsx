import { ChevronRight, Home } from 'lucide-react'
import { useFolderBreadcrumb } from '@/hooks/use-folders'

interface ExplorerBreadcrumbProps {
  workspaceId: string
  workspaceName: string
  currentFolderId: string | null
  onNavigate: (folderId: string | null) => void
}

export function ExplorerBreadcrumb({
  workspaceId,
  workspaceName,
  currentFolderId,
  onNavigate,
}: ExplorerBreadcrumbProps) {
  const { data } = useFolderBreadcrumb(workspaceId, currentFolderId)

  const segments: { id: string | null; name: string }[] = [
    { id: null, name: workspaceName },
  ]

  if (data) {
    for (const ancestor of data.ancestors) {
      segments.push({ id: ancestor.id, name: ancestor.name })
    }
    segments.push({ id: data.folder.id, name: data.folder.name })
  }

  return (
    <nav className="flex items-center gap-1 text-sm text-muted-foreground">
      {segments.map((segment, i) => {
        const isLast = i === segments.length - 1
        return (
          <span key={segment.id ?? 'root'} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="size-4" />}
            {isLast ? (
              <span className="font-medium text-foreground flex items-center gap-1">
                {i === 0 && <Home className="size-3.5" />}
                {segment.name}
              </span>
            ) : (
              <button
                onClick={() => onNavigate(segment.id)}
                className="flex items-center gap-1 hover:text-foreground transition-colors"
              >
                {i === 0 && <Home className="size-3.5" />}
                {segment.name}
              </button>
            )}
          </span>
        )
      })}
    </nav>
  )
}
