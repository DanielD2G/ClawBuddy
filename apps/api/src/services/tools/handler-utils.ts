import type { ToolCall } from '../../providers/llm.interface.js'
import type { SSEEmit } from '../../lib/sse.js'
import type { SecretInventory } from '../secret-redaction.service.js'

export interface ExecutionContext {
  workspaceId: string
  chatSessionId: string
  secretInventory?: SecretInventory
  /** Override browser session key for sub-agent isolation (defaults to chatSessionId) */
  browserSessionId?: string
  /** Pre-loaded capability data to avoid redundant DB lookups during tool execution */
  capability?: {
    slug: string
    skillType: string | null
    toolDefinitions: unknown
  }
  /** SSE emitter for streaming events (needed by sub-agent delegation) */
  emit?: SSEEmit
  /** Pre-loaded capabilities for the workspace (passed to sub-agents to avoid redundant DB queries) */
  capabilities?: Array<{
    slug: string
    toolDefinitions: unknown
    skillType?: string | null
    name: string
    systemPrompt: string
  }>
  /** Capability slugs the user explicitly mentioned (e.g. /browser-automation) — forwarded to sub-agents */
  mentionedSlugs?: string[]
  /** Abort signal to cancel the agent loop */
  signal?: AbortSignal
}

export interface DocumentSource {
  documentId: string
  documentTitle: string
  workspaceId?: string
  chunkId: string
  chunkIndex: number
}

export interface ExecutionResult {
  output: string
  error?: string
  exitCode?: number
  durationMs: number
  sources?: DocumentSource[]
  /** ID of the ToolExecution record created in the database */
  executionId?: string
  /** IDs of sub-agent ToolExecution records (for delegate_task) */
  subAgentExecutionIds?: string[]
}

export type ToolHandler = (
  toolCall: ToolCall,
  context: ExecutionContext,
) => Promise<ExecutionResult>

export const BINARY_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'ico',
  'pdf',
  'zip',
  'tar',
  'gz',
  'mp3',
  'mp4',
  'wav',
  'ogg',
  'woff',
  'woff2',
  'ttf',
  'otf',
])

export const MIME_TYPES: Record<string, string> = {
  csv: 'text/csv',
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  html: 'text/html',
  xml: 'application/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  zip: 'application/zip',
}
