import { Prisma } from '@prisma/client'
import type { ChatMessage, ToolCall } from '../providers/llm.interface.js'
import { decrypt, encrypt } from './crypto.service.js'
import type { SecretInventory } from './secret-redaction.service.js'
import { secretRedactionService } from './secret-redaction.service.js'

export interface AgentResult {
  content: string
  /** true when the agent paused to await tool approval (callers should NOT set idle or emit done) */
  paused?: boolean
  toolExecutions: Array<{
    toolName: string
    capabilitySlug: string
    input: Record<string, unknown>
    output?: string
    error?: string
    exitCode?: number
    durationMs: number
    subAgentExecutionIds?: string[]
  }>
  sources?: Array<{
    documentId: string
    documentTitle: string
    chunkId: string
    chunkIndex: number
  }>
  messageId?: string
  /** ID of the last ChatMessage saved during the agent loop */
  lastMessageId?: string
}

export interface AgentState {
  messages: ChatMessage[]
  iteration: number
  pendingToolCalls: ToolCall[]
  completedToolResults: Array<{ toolCallId: string; content: string }>
  toolExecutionLog: AgentResult['toolExecutions']
  workspaceId: string
  sessionId: string
  /** Slugs of capabilities discovered via tool discovery (for resume) */
  discoveredCapabilitySlugs?: string[]
  /** Capability slugs the user explicitly mentioned — forwarded to sub-agents on resume */
  mentionedSlugs?: string[]
}

export function serializeEncryptedAgentState(state: AgentState): string {
  return encrypt(JSON.stringify(state))
}

export function deserializeAgentState(session: {
  agentState: Prisma.JsonValue | null
  agentStateEncrypted?: string | null
}): AgentState | null {
  if (session.agentStateEncrypted) {
    try {
      return JSON.parse(decrypt(session.agentStateEncrypted)) as AgentState
    } catch {
      // Fall through to legacy plain JSON state below.
    }
  }
  return session.agentState as unknown as AgentState | null
}

export function buildPublicAgentState(state: AgentState, inventory: SecretInventory) {
  return {
    iteration: state.iteration,
    workspaceId: state.workspaceId,
    sessionId: state.sessionId,
    pendingToolCalls: state.pendingToolCalls.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      arguments: secretRedactionService.redactForPublicStorage(toolCall.arguments, inventory),
    })),
  }
}
