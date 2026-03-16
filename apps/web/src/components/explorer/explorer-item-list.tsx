import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { FolderOpen, FileText, Trash2, FolderPlus, Upload, MoreVertical, Loader2, RotateCcw } from 'lucide-react'
import { FolderDropTarget } from '@/components/explorer/drop-zone'
import type { Folder } from '@/hooks/use-folders'
import type { Document } from '@/hooks/use-documents'

const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  PENDING: 'secondary',
  PROCESSING: 'outline',
  READY: 'default',
  FAILED: 'destructive',
}

const typeIcons: Record<string, string> = {
  PDF: 'pdf',
  DOCX: 'docx',
  MARKDOWN: 'md',
  TXT: 'txt',
  HTML: 'html',
}

interface ExplorerItemListProps {
  folders: Folder[]
  documents: Document[]
  isLoading: boolean
  onFolderClick: (folderId: string) => void
  onDeleteFolder: (folderId: string) => void
  onDeleteDocument: (docId: string) => void
  onReingestDocument?: (docId: string) => void
  onDocumentClick: (docId: string) => void
  onDropFilesToFolder: (folderId: string, files: FileList) => void
  onMoveDocToFolder: (docId: string, folderId: string) => void
  onAddClick: () => void
}

export function ExplorerItemList({
  folders,
  documents,
  isLoading,
  onFolderClick,
  onDeleteFolder,
  onDeleteDocument,
  onReingestDocument,
  onDocumentClick,
  onDropFilesToFolder,
  onMoveDocToFolder,
  onAddClick,
}: ExplorerItemListProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <Skeleton key={i} className="h-28 w-full rounded-lg" />
        ))}
      </div>
    )
  }

  if (folders.length === 0 && documents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4">
        <div className="size-16 rounded-full bg-muted flex items-center justify-center">
          <FolderOpen className="size-8 text-muted-foreground" />
        </div>
        <div className="text-center">
          <p className="font-medium">This folder is empty</p>
          <p className="text-sm text-muted-foreground mt-1">
            Create a folder or upload a file to get started
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onAddClick}>
            <FolderPlus data-icon="inline-start" />
            New Folder
          </Button>
          <Button variant="outline" size="sm" onClick={onAddClick}>
            <Upload data-icon="inline-start" />
            Upload File
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Folders section */}
      {folders.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Folders
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {folders.map((folder) => (
              <FolderDropTarget
                key={folder.id}
                onFileDrop={(files) => onDropFilesToFolder(folder.id, files)}
                onDocumentDrop={(docId) => onMoveDocToFolder(docId, folder.id)}
                className="rounded-lg"
              >
                <Card
                  className="group cursor-pointer hover:bg-accent/50 hover:border-brand/30 transition-all [[data-drag-over]_&]:border-brand [[data-drag-over]_&]:bg-brand/10 [[data-drag-over]_&]:ring-2 [[data-drag-over]_&]:ring-brand/30"
                  onClick={() => onFolderClick(folder.id)}
                >
                  <CardContent className="flex items-center gap-3 p-3">
                    <FolderOpen className="size-5 text-brand shrink-0" />
                    <span className="text-sm font-medium truncate flex-1">
                      {folder.name}
                    </span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 opacity-0 group-hover:opacity-100 shrink-0"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreVertical className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={(e) => {
                            e.stopPropagation()
                            onDeleteFolder(folder.id)
                          }}
                        >
                          <Trash2 className="size-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </CardContent>
                </Card>
              </FolderDropTarget>
            ))}
          </div>
        </div>
      )}

      {/* Documents section */}
      {documents.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Files
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {documents.map((doc: any) => (
              <Card
                key={doc.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-agentbuddy-doc', doc.id)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onClick={() => doc.status === 'READY' && onDocumentClick(doc.id)}
                className={`group hover:bg-accent/50 hover:border-brand/30 transition-all overflow-hidden cursor-grab active:cursor-grabbing ${doc.status === 'READY' ? 'cursor-pointer' : 'opacity-60'}`}
              >
                {/* File preview area */}
                <div className="h-24 bg-muted/50 flex items-center justify-center border-b">
                  <div className="flex flex-col items-center gap-1">
                    <FileText className="size-8 text-muted-foreground/60" />
                    <span className="text-[10px] font-mono text-muted-foreground uppercase">
                      {typeIcons[doc.type] ?? doc.type}
                    </span>
                  </div>
                </div>
                {/* File info */}
                <CardContent className="p-3">
                  <div className="flex items-start justify-between gap-1">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate" title={doc.title}>
                        {doc.title}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-muted-foreground">
                          {new Date(doc.createdAt).toLocaleDateString()}
                        </span>
                        <Badge
                          variant={statusVariant[doc.status] ?? 'secondary'}
                          className="text-[10px] px-1.5 py-0"
                        >
                          {(doc.status === 'PROCESSING' || doc.status === 'PENDING') && doc.processingStep
                            ? doc.processingStep
                            : doc.status}
                        </Badge>
                      </div>
                      {(doc.status === 'PROCESSING' || doc.status === 'PENDING') && (
                        <div className="flex items-center gap-1.5 mt-1.5">
                          <Loader2 className="size-3 animate-spin text-muted-foreground" />
                          {doc.processingPct != null ? (
                            <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
                              <div
                                className="h-full rounded-full bg-brand transition-all duration-300"
                                style={{ width: `${doc.processingPct}%` }}
                              />
                            </div>
                          ) : (
                            <span className="text-[10px] text-muted-foreground">Processing...</span>
                          )}
                        </div>
                      )}
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 opacity-0 group-hover:opacity-100 shrink-0"
                        >
                          <MoreVertical className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {doc.status === 'FAILED' && onReingestDocument && (
                          <DropdownMenuItem onClick={() => onReingestDocument(doc.id)}>
                            <RotateCcw className="size-4" />
                            Retry
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => onDeleteDocument(doc.id)}
                        >
                          <Trash2 className="size-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
