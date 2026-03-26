import { Link } from 'react-router-dom'
import { FileText } from 'lucide-react'
import type { ChatMessage } from '@/hooks/use-chat'

export function SourcesList({ sources }: { sources: NonNullable<ChatMessage['sources']> }) {
  const seen = new Set<string>()
  const unique = sources.filter((s) => {
    const key = s.documentTitle
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {unique.map((s) => (
        <Link
          key={s.documentId}
          to={s.workspaceId ? `/workspaces/${s.workspaceId}/documents/${s.documentId}` : '#'}
          className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground no-underline hover:bg-muted/80 hover:text-foreground transition-colors"
        >
          <FileText className="size-3" />
          {s.documentTitle}
        </Link>
      ))}
    </div>
  )
}
