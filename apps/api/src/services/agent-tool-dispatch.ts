import { prisma } from '../lib/prisma.js'
import { Prisma } from '@prisma/client'
import type {
  ToolCall,
  ChatMessage,
  LLMToolDefinition,
  MessageContent,
} from '../providers/llm.interface.js'
import type { SSEEmit } from '../lib/sse.js'
import { capabilityService } from './capability.service.js'
import {
  toolExecutorService,
  NON_SANDBOX_TOOLS,
  type ExecutionResult,
} from './tool-executor.service.js'
import { permissionService } from './permission.service.js'
import {
  PARALLEL_SAFE_TOOLS,
  LARGE_TOOL_ARG_THRESHOLD,
  DELEGATION_ONLY_TOOLS,
} from '../constants.js'
import type { ToolDefinition } from '../capabilities/types.js'
import { stripNullBytes } from '../lib/sanitize.js'
import { logger } from '../lib/logger.js'
import type { SecretInventory } from './secret-redaction.service.js'
import { secretRedactionService } from './secret-redaction.service.js'
import {
  buildToolResultContent,
  maybeTruncateOutput,
  prepareToolResultForSSE,
} from './agent-tool-results.service.js'
import type { SessionLogger } from './agent-debug.service.js'
import { SUB_AGENT_ROLES } from './sub-agent-roles.js'
import type { SubAgentRole } from './sub-agent.types.js'
import { filterTools } from './sub-agent.service.js'
import type { AgentResult, AgentState } from './agent-state.service.js'
import { serializeEncryptedAgentState, buildPublicAgentState } from './agent-state.service.js'
import { checkToolArgSize } from './agent-token.service.js'
import { persistConversationLoadedCapabilitySlugs } from './agent-conversation-state.js'

export type ExecutableCapability = {
  slug: string
  toolDefinitions: unknown
  skillType?: string | null
}

type ToolExecutionLogEntry = NonNullable<AgentResult['toolExecutions']>[number]

/** Resolve sub-agent metadata for delegate_task approval events. */
export function resolveSubAgentMeta(
  toolCall: ToolCall,
  capabilities: Array<{ toolDefinitions: unknown; slug: string }>,
): Record<string, unknown> {
  if (toolCall.name !== 'delegate_task') return {}
  const role = (toolCall.arguments as { role?: string }).role
  const roleConfig = role ? SUB_AGENT_ROLES[role as SubAgentRole] : undefined
  if (!roleConfig) return {}
  const allTools = capabilityService.buildToolDefinitions(capabilities)
  const resolved = filterTools(allTools, roleConfig)
  return {
    subAgentRole: role,
    subAgentDescription: roleConfig.description,
    subAgentToolNames: resolved.map((t) => t.name),
  }
}

/** Redact tool call arguments using the secret inventory. */
export function redactAssistantToolCalls(
  toolCalls: ToolCall[] | undefined,
  inventory: SecretInventory,
): ToolCall[] | undefined {
  return toolCalls?.map((toolCall) => ({
    ...toolCall,
    arguments: secretRedactionService.redactForPublicStorage(toolCall.arguments, inventory),
  }))
}

/** Log tool call argument sizes for debugging large LLM outputs. */
export function logToolCallSizes(toolCalls: ToolCall[], log: SessionLogger): void {
  for (const tc of toolCalls) {
    const argsStr = JSON.stringify(tc.arguments)
    const argsSize = argsStr.length
    const commandArg = tc.arguments?.command ?? tc.arguments?.code ?? tc.arguments?.content
    const commandSize = typeof commandArg === 'string' ? commandArg.length : 0
    log.debugLog(`[TOOL_SIZE] ${tc.name}`, {
      totalArgsChars: argsSize,
      commandChars: commandSize,
      linesInCommand: typeof commandArg === 'string' ? commandArg.split('\n').length : 0,
      isLarge: argsSize > LARGE_TOOL_ARG_THRESHOLD,
      preview: argsStr.slice(0, 300),
    })
    if (argsSize > LARGE_TOOL_ARG_THRESHOLD) {
      log.debugLog(
        `[TOOL_SIZE_WARN] ${tc.name} generated ${argsSize} chars (${Math.round(argsSize / 1000)}KB) — possible data embedding`,
        {
          firstLines:
            typeof commandArg === 'string'
              ? commandArg.split('\n').slice(0, 5).join('\n')
              : undefined,
          lastLines:
            typeof commandArg === 'string'
              ? commandArg.split('\n').slice(-3).join('\n')
              : undefined,
        },
      )
    }
  }
}

/**
 * Measure how much of `newText` overlaps with `previousText` using 3-gram matching.
 * Returns a ratio between 0 (no overlap) and 1 (fully overlapping).
 * Used to detect when the LLM repeats itself across iterations.
 */
export function contentOverlapRatio(previousText: string, newText: string): number {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-záéíóúñü0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  const prev = normalize(previousText)
  const curr = normalize(newText)
  if (!prev || !curr) return 0

  const ngramSize = 3
  const words = curr.split(' ')
  if (words.length < ngramSize) return prev.includes(curr) ? 1 : 0

  const prevSet = new Set<string>()
  const prevWords = prev.split(' ')
  for (let i = 0; i <= prevWords.length - ngramSize; i++) {
    prevSet.add(prevWords.slice(i, i + ngramSize).join(' '))
  }

  let matches = 0
  const totalNgrams = words.length - ngramSize + 1
  for (let i = 0; i < totalNgrams; i++) {
    if (prevSet.has(words.slice(i, i + ngramSize).join(' '))) matches++
  }

  return totalNgrams > 0 ? matches / totalNgrams : 0
}

const EMPTY_FINAL_RESPONSE_FALLBACK =
  'I could not generate a response for that request. Please try again.'

export function getEmptyFinalResponseFallback(hasToolResults: boolean): string {
  return hasToolResults
    ? 'I found relevant results, but I could not generate a final response. Please try again.'
    : EMPTY_FINAL_RESPONSE_FALLBACK
}

/** Context passed to all tool dispatch operations within a single agent loop. */
export type ToolDispatchContext = {
  sessionId: string
  workspaceId: string
  inventory: SecretInventory
  emit?: SSEEmit
  log: SessionLogger
  messages: ChatMessage[]
  toolExecutionLog: ToolExecutionLogEntry[]
  collectedSources: NonNullable<AgentResult['sources']>
  capabilities: Array<{
    toolDefinitions: unknown
    slug: string
    networkAccess?: boolean
    name: string
    systemPrompt: string
    skillType?: string | null
  }>
  tools: LLMToolDefinition[]
  allowRules: string[]
  autoApprove?: boolean
  sandboxReady: boolean
  useDiscovery: boolean
  modelId: string
  mentionedSlugs?: string[]
  signal?: AbortSignal
  /** Discovered capabilities accumulated during the loop (mutated) */
  discoveredCapabilities: Array<{
    slug: string
    name: string
    toolDefinitions: ToolDefinition[]
    systemPrompt: string
    networkAccess?: boolean
    skillType?: string | null
  }>
  enabledCapabilitySlugs: Set<string>
  conversationLoadedCapabilitySlugs: string[]
}

type ReadyTool = {
  toolCall: ToolCall
  capabilitySlug: string
  matchedCapability: ExecutableCapability | undefined
  publicToolArgs: Record<string, unknown>
}

/** Resolve which capability a tool call belongs to. */
export function resolveCapability(
  toolCall: ToolCall,
  capabilities: ToolDispatchContext['capabilities'],
  discoveredCapabilities: ToolDispatchContext['discoveredCapabilities'],
): { matchedCapability: ExecutableCapability | undefined; capabilitySlug: string } {
  const matched =
    capabilities.find((cap) => {
      const defs = cap.toolDefinitions as Array<{ name: string }>
      return defs?.some((t) => t.name === toolCall.name)
    }) ??
    discoveredCapabilities.find((cap) => {
      return cap.toolDefinitions?.some((t) => t.name === toolCall.name)
    })
  return {
    matchedCapability: matched as ExecutableCapability | undefined,
    capabilitySlug:
      matched?.slug ?? (toolCall.name === 'discover_tools' ? 'tool-discovery' : 'unknown'),
  }
}

/**
 * Pre-check a tool call (discovery gate, permission, size guard).
 * Returns 'ok', 'rejected' (continue with next tool), or 'paused' (stop loop for approval).
 */
export async function preCheckTool(
  ctx: ToolDispatchContext,
  toolCall: ToolCall,
  capabilitySlug: string,
  matchedCapability: ExecutableCapability | undefined,
  publicToolArgs: Record<string, unknown>,
  iteration: number,
  pendingToolCalls: ToolCall[],
): Promise<'ok' | 'rejected' | 'paused'> {
  const {
    sessionId,
    emit,
    log,
    messages,
    toolExecutionLog,
    tools,
    useDiscovery,
    allowRules,
    inventory,
  } = ctx

  // Discovery mode: reject undiscovered tools
  if (useDiscovery && !tools.some((t) => t.name === toolCall.name)) {
    const rejection = `Tool "${toolCall.name}" is not yet available. Call discover_tools first to find and load the appropriate tools for your task.`
    log.debugLog(`[REJECTED] "${toolCall.name}" — not in available tools (discovery mode)`)
    emit?.('tool_start', {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      capabilitySlug,
      input: publicToolArgs,
    })
    emit?.('tool_result', {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      error: rejection,
      exitCode: 1,
      durationMs: 0,
    })
    toolExecutionLog.push({
      toolName: toolCall.name,
      capabilitySlug,
      input: publicToolArgs,
      error: rejection,
      durationMs: 0,
    })
    messages.push({ role: 'tool', toolCallId: toolCall.id, content: rejection })
    return 'rejected'
  }

  // Permission check
  const isAllowed = permissionService.isToolAllowed(toolCall, allowRules)
  log.debugLog(`Tool "${toolCall.name}" permission`, { isAllowed, capabilitySlug })

  if (!isAllowed && !ctx.autoApprove) {
    const approval = await prisma.toolApproval.create({
      data: {
        chatSessionId: sessionId,
        toolName: toolCall.name,
        capabilitySlug,
        input: publicToolArgs as Prisma.InputJsonValue,
        toolCallId: toolCall.id,
      },
    })

    emit?.('approval_required', {
      approvalId: approval.id,
      toolName: toolCall.name,
      capabilitySlug,
      input: publicToolArgs,
      ...resolveSubAgentMeta(toolCall, ctx.capabilities),
    })

    const agentState: AgentState = {
      messages,
      iteration,
      pendingToolCalls,
      completedToolResults: [],
      toolExecutionLog,
      workspaceId: ctx.workspaceId,
      sessionId,
      discoveredCapabilitySlugs: ctx.discoveredCapabilities.map((c) => c.slug),
      mentionedSlugs: ctx.mentionedSlugs,
    }
    await prisma.chatSession.update({
      where: { id: sessionId },
      data: {
        agentState: buildPublicAgentState(agentState, inventory) as Prisma.InputJsonValue,
        agentStateEncrypted: serializeEncryptedAgentState(agentState),
        agentStatus: 'awaiting_approval',
      },
    })
    const pendingApprovals = await prisma.toolApproval.findMany({
      where: { chatSessionId: sessionId, status: 'pending' },
      select: { id: true },
    })
    log.debugLog('Agent PAUSED — awaiting approval', {
      pendingCount: pendingApprovals.length,
    })
    emit?.('awaiting_approval', { approvalIds: pendingApprovals.map((a: { id: string }) => a.id) })
    return 'paused'
  }

  // Size guard
  const sizeRejection = checkToolArgSize(toolCall)
  if (sizeRejection) {
    log.debugLog(`[BLOCKED] "${toolCall.name}" — args too large`, {
      size: JSON.stringify(toolCall.arguments).length,
    })
    emit?.('tool_start', {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      capabilitySlug,
      input: { _blocked: true },
    })
    emit?.('tool_result', {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      error: sizeRejection,
      exitCode: 1,
      durationMs: 0,
    })
    toolExecutionLog.push({
      toolName: toolCall.name,
      capabilitySlug,
      input: { _blocked: true },
      error: sizeRejection,
      durationMs: 0,
    })
    messages.push({ role: 'tool', toolCallId: toolCall.id, content: sizeRejection })
    return 'rejected'
  }

  return 'ok'
}

/** Execute a single tool call and return the result. */
export async function executeSingleTool(
  ctx: ToolDispatchContext,
  toolCall: ToolCall,
  capabilitySlug: string,
  matchedCapability: ExecutableCapability | undefined,
  publicToolArgs: Record<string, unknown>,
): Promise<ExecutionResult> {
  const { log, emit, workspaceId, sessionId, inventory, capabilities, mentionedSlugs, signal } = ctx

  log.debugLog(`Executing tool "${toolCall.name}"`, {
    input: JSON.stringify(publicToolArgs).slice(0, 500),
  })
  const isDiscoveryTool = toolCall.name === 'discover_tools'
  if (isDiscoveryTool) emit?.('thinking', { message: 'Looking for the right tools...' })
  emit?.('tool_start', {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    capabilitySlug,
    input: publicToolArgs,
  })

  const toolStart = Date.now()
  const result = await toolExecutorService.execute(toolCall, capabilitySlug, {
    workspaceId,
    chatSessionId: sessionId,
    secretInventory: inventory,
    capability: matchedCapability
      ? {
          slug: matchedCapability.slug,
          skillType: (matchedCapability as Record<string, unknown>).skillType as string | null,
          toolDefinitions: matchedCapability.toolDefinitions,
        }
      : undefined,
    emit,
    capabilities,
    mentionedSlugs,
    signal,
  })

  log.debugLog(`Tool "${toolCall.name}" result`, {
    durationMs: Date.now() - toolStart,
    outputLength: result.output?.length ?? 0,
    outputPreview: result.output?.slice(0, 300) || '(empty)',
    error: result.error || null,
    exitCode: result.exitCode,
  })
  log.logToolResult(toolCall.name, result)
  return result
}

/** Post-process a tool execution result: emit SSE events, handle discovery injection, push message. */
export async function postProcessToolResult(
  ctx: ToolDispatchContext,
  toolCall: ToolCall,
  capabilitySlug: string,
  result: ExecutionResult,
  executionIds: string[],
): Promise<void> {
  const {
    emit,
    log,
    messages,
    toolExecutionLog,
    collectedSources,
    tools,
    discoveredCapabilities,
    enabledCapabilitySlugs,
    sandboxReady,
    workspaceId,
    sessionId,
    modelId,
    inventory,
  } = ctx
  const isDiscoveryTool = toolCall.name === 'discover_tools'

  // SSE events
  if (isDiscoveryTool) {
    let discoveryOutput = result.output || 'No tools discovered'
    try {
      const parsed = JSON.parse(result.output ?? '{}')
      if (parsed.discovered?.length) {
        discoveryOutput =
          'Discovered: ' + parsed.discovered.map((c: { name: string }) => c.name).join(', ')
      }
    } catch (err) {
      logger.warn('[Agent] Failed to parse discovery output', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    emit?.('tool_result', {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      output: discoveryOutput,
      durationMs: result.durationMs,
    })
  } else {
    const ssePayload = prepareToolResultForSSE(toolCall.name, result)
    emit?.('tool_result', {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      ...ssePayload,
      error: result.error,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    })
  }

  // Collect document sources
  if (result.sources?.length) {
    for (const s of result.sources) {
      if (!collectedSources.some((cs) => cs.documentId === s.documentId)) collectedSources.push(s)
    }
    emit?.('sources', { sources: collectedSources })
  }

  // Dynamic tool injection from discover_tools
  if (isDiscoveryTool && ctx.useDiscovery && result.output) {
    try {
      const parsed = JSON.parse(result.output)
      if (parsed.type === 'discovery_result' && parsed.discovered?.length) {
        const newCaps: typeof parsed.discovered = []
        for (const cap of parsed.discovered) {
          if (discoveredCapabilities.some((dc) => dc.slug === cap.slug)) continue
          newCaps.push(cap)
          discoveredCapabilities.push({
            slug: cap.slug,
            name: cap.name,
            toolDefinitions: cap.tools,
            systemPrompt: cap.instructions,
            networkAccess: cap.networkAccess,
            skillType: cap.skillType,
          })
          for (const tool of cap.tools as ToolDefinition[]) {
            if (!tools.some((t) => t.name === tool.name) && !DELEGATION_ONLY_TOOLS.has(tool.name)) {
              tools.push({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              })
            }
          }
        }
        if (newCaps.length < parsed.discovered.length) {
          result.output = JSON.stringify({ ...parsed, discovered: newCaps })
        }
        ctx.conversationLoadedCapabilitySlugs = await persistConversationLoadedCapabilitySlugs(
          sessionId,
          ctx.conversationLoadedCapabilitySlugs,
          newCaps.map((cap: { slug: string }) => cap.slug),
          enabledCapabilitySlugs,
        )
        log.debugLog('Tools dynamically injected', {
          newSlugs: newCaps.map((c: { slug: string }) => c.slug),
          skippedDuplicates: parsed.discovered.length - newCaps.length,
          totalTools: tools.length,
        })
      }
    } catch (err) {
      logger.warn('[Agent] Discovery output parse failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Persist successful capability usage
  if (!result.error && capabilitySlug !== 'unknown') {
    ctx.conversationLoadedCapabilitySlugs = await persistConversationLoadedCapabilitySlugs(
      sessionId,
      ctx.conversationLoadedCapabilitySlugs,
      [capabilitySlug],
      enabledCapabilitySlugs,
    )
  }

  // Push to execution log
  const publicToolArgs = secretRedactionService.redactForPublicStorage(
    toolCall.arguments,
    inventory,
  )
  toolExecutionLog.push({
    toolName: toolCall.name,
    capabilitySlug,
    input: publicToolArgs,
    output: result.output || undefined,
    error: result.error,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    subAgentExecutionIds: result.subAgentExecutionIds,
  })
  if (result.executionId) executionIds.push(result.executionId)
  if (result.subAgentExecutionIds?.length) {
    executionIds.push(...result.subAgentExecutionIds)
  }

  // Add tool result to conversation
  const rawContent =
    toolCall.name === 'run_browser_script'
      ? result.output
      : result.error
        ? `Error: ${result.error}\n\n${result.output}`
        : result.output
  const isSandboxTool = !NON_SANDBOX_TOOLS.has(toolCall.name)
  const toolContent =
    sandboxReady && isSandboxTool
      ? await maybeTruncateOutput(rawContent, toolCall.id, workspaceId)
      : rawContent
  const messageContent: MessageContent =
    toolCall.name === 'run_browser_script'
      ? buildToolResultContent(toolContent, modelId)
      : toolContent
  messages.push({ role: 'tool', toolCallId: toolCall.id, content: messageContent })
}

/**
 * Pre-check all tool calls and execute them (parallel-safe concurrently, others sequentially).
 * Returns 'paused' if an approval is needed, 'done' otherwise.
 */
export async function executeToolCalls(
  ctx: ToolDispatchContext,
  toolCalls: ToolCall[],
  iteration: number,
): Promise<{ status: 'done' | 'paused'; executionIds: string[] }> {
  const { inventory } = ctx
  const executionIds: string[] = []

  // First pass: pre-check all tools, collect those ready to execute
  const readyTools: ReadyTool[] = []
  let paused = false

  for (const toolCall of toolCalls) {
    const { matchedCapability, capabilitySlug } = resolveCapability(
      toolCall,
      ctx.capabilities,
      ctx.discoveredCapabilities,
    )
    const publicToolArgs = secretRedactionService.redactForPublicStorage(
      toolCall.arguments,
      inventory,
    )
    const checkResult = await preCheckTool(
      ctx,
      toolCall,
      capabilitySlug,
      matchedCapability,
      publicToolArgs,
      iteration,
      toolCalls,
    )
    if (checkResult === 'paused') {
      paused = true
      break
    }
    if (checkResult === 'rejected') continue
    readyTools.push({ toolCall, capabilitySlug, matchedCapability, publicToolArgs })
  }

  if (paused) {
    return { status: 'paused', executionIds }
  }

  // Second pass: execute — parallel-safe tools concurrently, others sequentially
  const parallelBatch = readyTools.filter((t) => PARALLEL_SAFE_TOOLS.has(t.toolCall.name))
  const sequentialBatch = readyTools.filter((t) => !PARALLEL_SAFE_TOOLS.has(t.toolCall.name))

  const executeAndProcess = async (batch: ReadyTool[], parallel: boolean) => {
    if (batch.length === 0) return

    const results =
      parallel && batch.length > 1
        ? await Promise.all(
            batch.map((t) =>
              executeSingleTool(
                ctx,
                t.toolCall,
                t.capabilitySlug,
                t.matchedCapability,
                t.publicToolArgs,
              ),
            ),
          )
        : []

    for (let idx = 0; idx < batch.length; idx++) {
      const { toolCall, capabilitySlug, matchedCapability, publicToolArgs } = batch[idx]
      const result =
        parallel && batch.length > 1
          ? results[idx]
          : await executeSingleTool(
              ctx,
              toolCall,
              capabilitySlug,
              matchedCapability,
              publicToolArgs,
            )

      await postProcessToolResult(ctx, toolCall, capabilitySlug, result, executionIds)
    }
  }

  if (parallelBatch.length > 1) {
    ctx.log.debugLog('Executing parallel batch', {
      tools: parallelBatch.map((t) => t.toolCall.name),
    })
  }
  await executeAndProcess(parallelBatch, true)
  await executeAndProcess(sequentialBatch, false)

  return { status: 'done', executionIds }
}

/** Save an iteration's assistant message and tool executions to the database. */
export async function persistIterationMessage(
  ctx: ToolDispatchContext,
  safeResponseContent: string,
  toolCalls: ToolCall[],
  executionIds: string[],
): Promise<string | undefined> {
  const { sessionId, log, inventory, toolExecutionLog, collectedSources } = ctx

  try {
    const iterToolCalls = toolCalls.map((tc) => {
      const { capabilitySlug } = resolveCapability(tc, ctx.capabilities, ctx.discoveredCapabilities)
      return {
        name: tc.name,
        capability: capabilitySlug,
        input: secretRedactionService.redactForPublicStorage(tc.arguments, inventory),
      }
    })

    const iterBlocks: Array<
      | { type: 'text'; text: string }
      | { type: 'tool'; toolIndex: number }
      | {
          type: 'sub_agent'
          toolIndex: number
          subAgentId: string
          role: string
          task: string
          subToolIds?: string[]
        }
    > = []
    if (safeResponseContent.trim()) {
      iterBlocks.push({ type: 'text', text: safeResponseContent })
    }
    const iterLogEntries = toolExecutionLog.slice(-toolCalls.length)
    for (let t = 0; t < toolCalls.length; t++) {
      const tc = toolCalls[t]
      if (tc.name === 'delegate_task') {
        const args = tc.arguments as Record<string, unknown>
        const logEntry = iterLogEntries[t]
        iterBlocks.push({
          type: 'sub_agent',
          toolIndex: t,
          subAgentId: tc.id,
          role: String(args.role ?? 'execute'),
          task: String(args.task ?? ''),
          subToolIds: logEntry?.subAgentExecutionIds,
        })
      } else {
        iterBlocks.push({ type: 'tool', toolIndex: t })
      }
    }

    // Extract generated file attachments for this iteration
    const iterGeneratedFiles = toolExecutionLog
      .slice(-toolCalls.length)
      .filter((te) => te.toolName === 'generate_file' && te.output && !te.error)
      .map((te) => {
        try {
          const parsed = JSON.parse(te.output!)
          if (parsed.filename && parsed.downloadUrl) {
            return {
              name: parsed.filename,
              url: parsed.downloadUrl,
              storageKey: '',
              type: 'generated',
              size: 0,
            }
          }
        } catch {
          /* not JSON */
        }
        return null
      })
      .filter(Boolean)

    const iterMsg = await prisma.chatMessage.create({
      data: {
        sessionId,
        role: 'assistant',
        content: stripNullBytes(safeResponseContent),
        toolCalls: iterToolCalls.length
          ? (JSON.parse(stripNullBytes(JSON.stringify(iterToolCalls))) as Prisma.InputJsonValue)
          : undefined,
        ...(iterBlocks.length
          ? { contentBlocks: iterBlocks as unknown as Prisma.InputJsonValue }
          : {}),
        ...(iterGeneratedFiles.length ? { attachments: iterGeneratedFiles } : {}),
        ...(collectedSources.length ? { sources: collectedSources } : {}),
      },
    })

    if (executionIds.length) {
      await prisma.toolExecution.updateMany({
        where: { id: { in: executionIds } },
        data: { chatMessageId: iterMsg.id },
      })
    }

    log.debugLog('Saved iteration message', {
      messageId: iterMsg.id,
      toolCount: toolCalls.length,
      executionIds: executionIds.length,
    })

    return iterMsg.id
  } catch (saveErr) {
    logger.error('[Agent] Failed to save iteration message', saveErr, { sessionId })
    return undefined
  }
}
