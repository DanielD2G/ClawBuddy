import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { Send } from 'lucide-react'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { useWorkspaceCapabilities } from '@/hooks/use-capabilities'
import { useDocuments } from '@/hooks/use-documents'
import { useFolders } from '@/hooks/use-folders'
import { useActiveWorkspace } from '@/providers/workspace-provider'
import { MentionInput } from '@/components/chat/mention-input'
import { ChatAttachMenu } from '@/components/chat/chat-attach-menu'

export function DashboardPage() {
  const navigate = useNavigate()
  const { data: workspaces } = useWorkspaces()
  const { activeWorkspaceId } = useActiveWorkspace()
  const { data: allCapabilities = [] } = useWorkspaceCapabilities(activeWorkspaceId)
  const enabledCapabilities = allCapabilities.filter((c) => c.enabled !== false)
  const { data: allDocuments = [] } = useDocuments(activeWorkspaceId ?? '')
  const readyDocuments = allDocuments.filter((d) => d.status === 'READY')
  const { data: allFolders = [] } = useFolders(activeWorkspaceId ?? '')
  const { data: allDocsForMenu = [] } = useQuery({
    queryKey: ['all-documents'],
    queryFn: () =>
      apiClient.get<
        Array<{
          id: string
          title: string
          workspaceId: string
          status: string
          workspace?: { name: string }
        }>
      >('/documents'),
  })
  const [input, setInput] = useState('')
  const [focused, setFocused] = useState(false)
  const [mentionedDocIds, setMentionedDocIds] = useState<string[]>([])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim()) return

    navigate('/chat', {
      state: {
        initialMessage: input,
        ...(mentionedDocIds.length ? { documentIds: mentionedDocIds } : {}),
      },
    })
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 -mt-16">
      <h1 className="mb-8 text-4xl font-semibold tracking-tight text-foreground">
        How can I help you today?
      </h1>

      <form onSubmit={handleSubmit} className="w-full max-w-[680px]">
        {/* Input bar */}
        <div
          className={`
            relative flex items-center gap-3 rounded-full
            bg-muted/60 px-5 py-3
            border border-border/40
            backdrop-blur-sm
            transition-all duration-200
            ${focused ? 'border-border/80 bg-muted/80 shadow-lg shadow-black/5' : ''}
          `}
        >
          <ChatAttachMenu
            onSelectFile={(title) => setInput((v) => `${v}@${title} `)}
            onSelectTool={(slug) => setInput((v) => `${v}/${slug} `)}
            capabilities={enabledCapabilities}
            documents={allDocsForMenu}
          />

          <MentionInput
            value={input}
            onChange={setInput}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Ask anything — use / for tools, @ for files"
            onDocumentMentionsChange={setMentionedDocIds}
            capabilities={enabledCapabilities}
            documents={readyDocuments}
            folders={allFolders}
          />

          {/* Send button */}
          <button
            type="submit"
            disabled={!input.trim()}
            className={`
              flex size-10 shrink-0 items-center justify-center rounded-full
              transition-all duration-200
              ${
                input.trim()
                  ? 'bg-brand text-brand-foreground shadow-md hover:opacity-90'
                  : 'bg-muted-foreground/20 text-muted-foreground/50 cursor-not-allowed'
              }
            `}
          >
            <Send className="size-[18px]" strokeWidth={2} />
          </button>
        </div>
      </form>

      {/* Hint to create workspace only when there are no documents */}
      {(!workspaces || workspaces.length === 0) && (
        <p className="mt-4 text-sm text-muted-foreground">
          Create a workspace to upload documents for contextual chat.
        </p>
      )}
    </div>
  )
}
