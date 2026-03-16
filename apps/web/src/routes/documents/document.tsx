import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, FileText } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useDocument } from '@/hooks/use-documents'

const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  PENDING: 'secondary',
  PROCESSING: 'outline',
  READY: 'default',
  FAILED: 'destructive',
}

const typeLabels: Record<string, string> = {
  PDF: 'PDF',
  DOCX: 'DOCX',
  MARKDOWN: 'Markdown',
  TXT: 'Text',
  HTML: 'HTML',
}

export function DocumentPage() {
  const { id: workspaceId, docId } = useParams<{ id: string; docId: string }>()
  const navigate = useNavigate()
  const { data: doc, isLoading, isError } = useDocument(workspaceId!, docId!)

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[400px] w-full rounded-lg" />
      </div>
    )
  }

  if (isError || !doc) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4">
        <FileText className="size-12 text-muted-foreground/40" />
        <p className="text-muted-foreground">Document not found</p>
        <Button variant="outline" onClick={() => navigate(`/workspaces/${workspaceId}`)}>
          <ArrowLeft data-icon="inline-start" />
          Back to workspace
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate(`/workspaces/${workspaceId}`)}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold truncate">{doc.title}</h1>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant="outline">{typeLabels[doc.type] ?? doc.type}</Badge>
            <Badge variant={statusVariant[doc.status] ?? 'secondary'}>{doc.status}</Badge>
            <span className="text-xs text-muted-foreground">
              {new Date(doc.createdAt).toLocaleDateString()}
            </span>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="rounded-lg border bg-card p-6">
        {doc.status !== 'READY' ? (
          <p className="text-muted-foreground text-sm">
            {doc.status === 'FAILED'
              ? 'Document processing failed.'
              : 'Document is still being processed...'}
          </p>
        ) : !doc.content ? (
          <p className="text-muted-foreground text-sm">No content available for this document.</p>
        ) : doc.type === 'MARKDOWN' ? (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <Markdown remarkPlugins={[remarkGfm]}>{doc.content}</Markdown>
          </div>
        ) : (
          <pre className="whitespace-pre-wrap text-sm font-sans leading-relaxed">
            {doc.content}
          </pre>
        )}
      </div>
    </div>
  )
}
