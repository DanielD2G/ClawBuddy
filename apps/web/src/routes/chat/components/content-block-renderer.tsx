import type { MutableRefObject } from 'react'
import { X, Download } from 'lucide-react'
import type { ContentBlock, ChatMessage } from '@/hooks/use-chat'
import { ToolExecutionBlock } from '@/components/chat/tool-execution-block'
import { SubAgentBlock } from '@/components/chat/sub-agent-block'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { parseRichBlocks } from '@/lib/rich-block-parser'
import { richBlockRenderers } from '@/components/chat/rich-blocks'

function ContentBlockItem({
  block,
  index,
  msg,
  expandedToolsRef,
}: {
  block: ContentBlock
  index: number
  msg: ChatMessage
  expandedToolsRef: MutableRefObject<Set<string>>
}) {
  if (block.type === 'sub_agent') {
    return (
      <div key={block.subAgent.id ?? `sub-agent-${index}`} className="mb-2">
        <SubAgentBlock subAgent={block.subAgent} expandedToolsRef={expandedToolsRef} />
      </div>
    )
  }

  if (
    block.type === 'tool' &&
    block.tool.toolName !== 'search_documents' &&
    block.tool.toolName !== 'delegate_task'
  ) {
    return (
      <div key={block.tool.id ?? block.tool.toolCallId ?? `tool-${index}`} className="mb-2">
        <ToolExecutionBlock
          execution={block.tool}
          toolKey={block.tool.id ?? block.tool.toolCallId ?? `${msg.id}-tool-${index}`}
          expandedToolsRef={expandedToolsRef}
        />
      </div>
    )
  }

  if (block.type === 'text' && block.text.trim()) {
    return (
      <div key={`text-${index}`}>
        {block.text.startsWith('Action skipped') ? (
          <div className="flex items-center gap-2 rounded-lg border border-muted bg-muted/30 px-3 py-2 text-sm text-muted-foreground mb-2">
            <X className="size-3.5 shrink-0" />
            {block.text}
          </div>
        ) : (
          <div className={msg.isError ? 'text-destructive' : 'chat-markdown'}>
            {msg.isError ? (
              <p>{block.text}</p>
            ) : (
              parseRichBlocks(block.text).map((segment, j) => {
                if (segment.type === 'text') {
                  return (
                    <ReactMarkdown key={`md-${j}`} remarkPlugins={[remarkGfm]}>
                      {segment.text}
                    </ReactMarkdown>
                  )
                }
                const Renderer = richBlockRenderers[segment.type]
                return Renderer ? <Renderer key={`rich-${j}`} {...segment} /> : null
              })
            )}
          </div>
        )}
      </div>
    )
  }

  return null
}

export function ContentBlockRenderer({
  blocks,
  msg,
  expandedToolsRef,
}: {
  blocks: ContentBlock[]
  msg: ChatMessage
  expandedToolsRef: MutableRefObject<Set<string>>
}) {
  return (
    <>
      {blocks.map((block, i) => (
        <ContentBlockItem
          key={
            block.type === 'sub_agent'
              ? (block.subAgent.id ?? `sub-agent-${i}`)
              : block.type === 'tool'
                ? (block.tool.id ?? block.tool.toolCallId ?? `tool-${i}`)
                : `text-${i}`
          }
          block={block}
          index={i}
          msg={msg}
          expandedToolsRef={expandedToolsRef}
        />
      ))}

      {/* File attachments from assistant (generated files) */}
      {msg.attachments && msg.attachments.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {msg.attachments.map((att) => (
            <a
              key={att.storageKey ?? att.url}
              href={att.url}
              download={att.name}
              className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
            >
              <Download className="size-3.5" />
              {att.name}
            </a>
          ))}
        </div>
      )}
    </>
  )
}
