import { useState, useEffect, useCallback } from 'react'
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

const GREETING_PHRASES = [
  'How can I help you?',
  'What do you need?',
  'Ready when you are.',
  'What are you working on?',
  'Ask me anything.',
]

function TypingGreeting() {
  const [text, setText] = useState('')
  const [phraseIdx, setPhraseIdx] = useState(0)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isPaused, setIsPaused] = useState(false)

  const tick = useCallback(() => {
    const phrase = GREETING_PHRASES[phraseIdx]
    if (isPaused) return

    if (!isDeleting) {
      if (text.length < phrase.length) {
        setText(phrase.slice(0, text.length + 1))
      } else {
        setIsPaused(true)
        setTimeout(() => {
          setIsPaused(false)
          setIsDeleting(true)
        }, 2000)
      }
    } else {
      if (text.length > 0) {
        setText(phrase.slice(0, text.length - 1))
      } else {
        setIsDeleting(false)
        setPhraseIdx((i) => (i + 1) % GREETING_PHRASES.length)
      }
    }
  }, [text, phraseIdx, isDeleting, isPaused])

  useEffect(() => {
    const speed = isDeleting ? 30 : 50 + Math.random() * 40
    const timer = setTimeout(tick, speed)
    return () => clearTimeout(timer)
  }, [tick, isDeleting])

  return (
    <h1 className="mb-4 text-2xl font-semibold tracking-tight text-foreground sm:text-4xl whitespace-nowrap text-center">
      {text}
      <span className="ml-0.5 inline-block w-[2px] h-[1.1em] align-text-bottom bg-brand animate-pulse" />
    </h1>
  )
}

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
      <TypingGreeting />

      <form onSubmit={handleSubmit} className="w-full max-w-[680px]">
        {/* Input bar — morphs from pill to rounded rect when text wraps */}
        <div
          className={`
            relative flex flex-col
            bg-muted/60 px-3 pt-3 pb-2
            border border-border/40
            backdrop-blur-sm
            transition-all duration-300 ease-out
            ${input.includes('\n') || input.length > 60 ? 'rounded-2xl' : 'rounded-[1.5rem]'}
            ${focused ? 'border-border/80 bg-muted/80 shadow-lg shadow-black/5' : ''}
          `}
        >
          {/* Text area */}
          <div className="flex-1 min-w-0 px-1">
            <MentionInput
              value={input}
              onChange={setInput}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="Ask anything..."
              onDocumentMentionsChange={setMentionedDocIds}
              capabilities={enabledCapabilities}
              documents={readyDocuments}
              folders={allFolders}
            />
          </div>

          {/* Bottom row: attach + send */}
          <div className="flex items-center justify-between mt-1">
            <ChatAttachMenu
              onSelectFile={(title) => setInput((v) => `${v}@${title} `)}
              onSelectTool={(slug) => setInput((v) => `${v}/${slug} `)}
              capabilities={enabledCapabilities}
              documents={allDocsForMenu}
            />

            <button
              type="submit"
              disabled={!input.trim()}
              className={`
                flex size-8 shrink-0 items-center justify-center rounded-full
                transition-all duration-200
                ${
                  input.trim()
                    ? 'bg-brand text-brand-foreground shadow-md hover:opacity-90'
                    : 'bg-muted-foreground/20 text-muted-foreground/50 cursor-not-allowed'
                }
              `}
            >
              <Send className="size-4" strokeWidth={2} />
            </button>
          </div>
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
