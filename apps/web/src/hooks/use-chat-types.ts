export interface ToolExecutionData {
  id?: string
  toolCallId?: string
  toolName: string
  capabilitySlug?: string
  input: Record<string, unknown>
  output?: string | null
  error?: string | null
  exitCode?: number | null
  durationMs?: number | null
  screenshot?: string | null
  status?: string
}

export interface ChatAttachment {
  name: string
  size?: number
  type?: string
  storageKey?: string
  url: string
}

export type SubAgentRole = 'explore' | 'analyze' | 'execute'

export interface SubAgentData {
  id?: string
  role: SubAgentRole
  task: string
  tools: ToolExecutionData[]
  summary?: string
  status: string
  durationMs?: number
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool'; tool: ToolExecutionData }
  | { type: 'sub_agent'; subAgent: SubAgentData }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources?: {
    documentId: string
    documentTitle: string
    workspaceId?: string
    chunkId: string
    chunkIndex: number
  }[]
  toolExecutions?: ToolExecutionData[]
  contentBlocks?: ContentBlock[]
  attachments?: ChatAttachment[]
  isError?: boolean
  createdAt: string
}

export interface PendingApproval {
  approvalId: string
  toolName: string
  capabilitySlug: string
  input: Record<string, unknown>
  subAgentRole?: string
  subAgentDescription?: string
  subAgentToolNames?: string[]
}
