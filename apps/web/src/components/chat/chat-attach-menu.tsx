import { useState } from 'react'
import { Plus, FileText, Wrench, Check } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

interface Document {
  id: string
  title: string
  workspaceId: string
  status: string
  workspace?: { name: string }
}

interface ChatAttachMenuProps {
  onSelectFile?: (title: string) => void
  onSelectTool?: (slug: string) => void
  capabilities: Array<{ slug: string; name: string; description: string; icon: string | null }>
  documents: Array<{ id: string; title: string; workspaceId: string; status: string; workspace?: { name: string } }>
}

export function ChatAttachMenu({ onSelectFile, onSelectTool, capabilities, documents }: ChatAttachMenuProps) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'files' | 'tools'>('files')

  const readyDocs = documents.filter((d) => d.status === 'READY')

  // Group docs by workspace
  const grouped = readyDocs.reduce<Record<string, { name: string; docs: Document[] }>>(
    (acc, doc) => {
      const wsId = doc.workspaceId
      if (!acc[wsId]) {
        acc[wsId] = { name: doc.workspace?.name ?? 'Workspace', docs: [] }
      }
      acc[wsId].docs.push(doc)
      return acc
    },
    {},
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`
            flex size-8 shrink-0 items-center justify-center rounded-full
            transition-colors
            ${open
              ? 'bg-brand/15 text-brand'
              : 'text-muted-foreground hover:text-foreground'
            }
          `}
        >
          <Plus className="size-5" strokeWidth={1.5} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={12}
        className="w-80 p-0"
      >
        {/* Tabs */}
        <div className="flex border-b">
          <button
            type="button"
            onClick={() => setTab('files')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm font-medium transition-colors ${
              tab === 'files'
                ? 'border-b-2 border-brand text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <FileText className="size-3.5" />
            Files
          </button>
          <button
            type="button"
            onClick={() => setTab('tools')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm font-medium transition-colors ${
              tab === 'tools'
                ? 'border-b-2 border-brand text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Wrench className="size-3.5" />
            Tools
          </button>
        </div>

        <div className="h-64 overflow-y-auto">
          {tab === 'files' && (
            <>
              {Object.keys(grouped).length === 0 && (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No documents yet
                </div>
              )}
              {Object.entries(grouped).map(([wsId, group]) => (
                <div key={wsId}>
                  <div className="sticky top-0 bg-popover px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {group.name}
                  </div>
                  {group.docs.map((doc) => (
                    <button
                      key={doc.id}
                      type="button"
                      onClick={() => {
                        onSelectFile?.(doc.title)
                        setOpen(false)
                      }}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      <FileText className="size-4 shrink-0" />
                      <span className="flex-1 truncate">{doc.title}</span>
                    </button>
                  ))}
                </div>
              ))}
            </>
          )}

          {tab === 'tools' && (
            <>
              {capabilities.length === 0 && (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No tools enabled
                </div>
              )}
              {capabilities.map((cap) => (
                <button
                  key={cap.slug}
                  type="button"
                  onClick={() => {
                    onSelectTool?.(cap.slug)
                    setOpen(false)
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  <Wrench className="size-4 shrink-0 text-muted-foreground" />
                  <div className="flex-1 min-w-0 text-left">
                    <div className="font-medium">/{cap.slug}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {cap.name}
                    </div>
                  </div>
                  <Check className="size-4 shrink-0 text-brand" />
                </button>
              ))}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
