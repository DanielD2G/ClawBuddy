import { prisma } from '../lib/prisma.js'
import { Prisma } from '@prisma/client'
import { createLLMProvider } from '../providers/index.js'
import type {
  ChatMessage,
  ToolCall,
  TokenUsage,
  MessageContent,
  LLMToolDefinition,
} from '../providers/llm.interface.js'
import type { SSEEmit } from '../lib/sse.js'
import { capabilityService } from './capability.service.js'
import {
  toolExecutorService,
  NON_SANDBOX_TOOLS,
  type ExecutionResult,
} from './tool-executor.service.js'
import { sandboxService } from './sandbox.service.js'
import { permissionService } from './permission.service.js'
import { compressContext } from './context-compression.service.js'
import { settingsService } from './settings.service.js'
import {
  TOOL_ARG_SIZE_LIMIT,
  LARGE_TOOL_ARG_THRESHOLD,
  MAX_AGENT_DOCUMENTS,
  TOOL_DISCOVERY_THRESHOLD,
  ALWAYS_ON_CAPABILITY_SLUGS,
  PREFLIGHT_DISCOVERY_SCORE_THRESHOLD,
  DELEGATION_ONLY_TOOLS,
  PARALLEL_SAFE_TOOLS,
} from '../constants.js'
import { toolDiscoveryService } from './tool-discovery.service.js'
import type { ToolDefinition } from '../capabilities/types.js'
import { stripNullBytes } from '../lib/sanitize.js'
import type { SecretInventory } from './secret-redaction.service.js'
import { secretRedactionService } from './secret-redaction.service.js'
import { buildConversationMessages } from './agent-message-builder.js'
import {
  buildToolResultContent,
  maybeTruncateOutput,
  prepareToolResultForSSE,
  pruneOldToolResults,
} from './agent-tool-results.service.js'
import { createSessionLogger } from './agent-debug.service.js'
import { buildCapabilityBlocks, buildPromptSection } from './system-prompt-builder.js'
import { SUB_AGENT_ROLES } from './sub-agent-roles.js'
import type { SubAgentRole } from './sub-agent.types.js'
import { filterTools } from './sub-agent.service.js'
import type { AgentResult, AgentState } from './agent-state.service.js'
import {
  serializeEncryptedAgentState,
  deserializeAgentState,
  buildPublicAgentState,
} from './agent-state.service.js'

/** Resolve sub-agent metadata for delegate_task approval events. */
function resolveSubAgentMeta(
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

/**
 * Measure how much of `newText` overlaps with `previousText` using 3-gram matching.
 * Returns a ratio between 0 (no overlap) and 1 (fully overlapping).
 * Used to detect when the LLM repeats itself across iterations.
 */
function contentOverlapRatio(previousText: string, newText: string): number {
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

/** Tools exempt from the argument size guard (they have proper alternatives like sourcePath) */
const SIZE_GUARD_EXEMPT = new Set(['generate_file', 'save_document', 'search_documents'])

/**
 * Check if a tool call's arguments exceed the size limit.
 * Returns a rejection message if too large, null otherwise.
 */
export function checkToolArgSize(toolCall: {
  name: string
  arguments: Record<string, unknown>
}): string | null {
  if (SIZE_GUARD_EXEMPT.has(toolCall.name)) return null
  const commandArg =
    toolCall.arguments?.command ?? toolCall.arguments?.code ?? toolCall.arguments?.content
  if (typeof commandArg !== 'string' || commandArg.length <= TOOL_ARG_SIZE_LIMIT) return null

  const sizeKB = Math.round(commandArg.length / 1000)
  return (
    `[BLOCKED] ${toolCall.name} contains ${sizeKB}KB inline data (limit: 10KB). ` +
    `Reference files instead of embedding data:\n` +
    `1. Previous outputs are saved in /workspace/.outputs/ — read from there\n` +
    `2. Write a script that processes the file (e.g. cat /workspace/.outputs/<id>.txt | jq ...)\n` +
    `3. For generate_file, use sourcePath to reference the sandbox file\n\n` +
    `Command was NOT executed. Rewrite to reference files.`
  )
}

export async function recordTokenUsage(
  usage: TokenUsage | undefined,
  sessionId: string,
  provider: string,
  model: string,
  options?: {
    updateSessionContext?: boolean
  },
) {
  if (!usage) return
  try {
    const date = new Date().toISOString().slice(0, 10)
    const writes: Promise<unknown>[] = [
      prisma.tokenUsage.create({
        data: {
          provider,
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          sessionId,
          date,
        },
      }),
    ]
    if (options?.updateSessionContext !== false) {
      writes.push(
        prisma.chatSession.update({
          where: { id: sessionId },
          data: { lastInputTokens: usage.inputTokens },
        }),
      )
    }
    await Promise.all(writes)
  } catch (err) {
    console.error('[Agent] Failed to record token usage:', err)
  }
}

function redactAssistantToolCalls(
  toolCalls: ToolCall[] | undefined,
  inventory: SecretInventory,
): ToolCall[] | undefined {
  return toolCalls?.map((toolCall) => ({
    ...toolCall,
    arguments: secretRedactionService.redactForPublicStorage(toolCall.arguments, inventory),
  }))
}

type ExecutableCapability = {
  slug: string
  toolDefinitions: unknown
  skillType?: string | null
}

export const agentService = {
  /**
   * Run the agent loop with tool calling and SSE streaming.
   */
  async runAgentLoop(
    sessionId: string,
    userContent: string,
    workspaceId: string,
    emit?: SSEEmit,
    options?: {
      autoApprove?: boolean
      mentionedSlugs?: string[]
      secretInventory?: SecretInventory
      historyIncludesCurrentUserMessage?: boolean
      signal?: AbortSignal
    },
  ): Promise<AgentResult> {
    const inventory =
      options?.secretInventory ?? (await secretRedactionService.buildSecretInventory(workspaceId))
    const safeUserContent = secretRedactionService.redactForPublicStorage(userContent, inventory)
    const log = createSessionLogger(sessionId, inventory)
    log.debugLog('runAgentLoop START', {
      sessionId,
      workspaceId,
      userContent: safeUserContent.slice(0, 200),
    })
    emit?.('thinking', { message: 'Thinking...' })

    // Get workspace-scoped capabilities
    const capabilities = await capabilityService.getEnabledCapabilitiesForWorkspace(workspaceId)

    // Discovery mode: when many capabilities are enabled, use dynamic tool loading
    const useDiscovery = capabilities.length >= TOOL_DISCOVERY_THRESHOLD
    let tools: LLMToolDefinition[]
    let systemPrompt: string
    // Track dynamically discovered capabilities during the agent loop
    const discoveredCapabilities: Array<{
      slug: string
      name: string
      toolDefinitions: ToolDefinition[]
      systemPrompt: string
      networkAccess?: boolean
      skillType?: string | null
    }> = []

    const timezone = await settingsService.getTimezone()

    if (useDiscovery) {
      const ctx = toolDiscoveryService.buildDiscoveryContext(
        capabilities,
        options?.mentionedSlugs,
        timezone,
      )
      tools = ctx.tools
      systemPrompt = ctx.systemPrompt
      log.debugLog('Discovery mode ACTIVE', {
        capabilityCount: capabilities.length,
        loadedTools: tools.map((t) => t.name),
        alwaysOnSlugs: ctx.alwaysOnSlugs,
      })

      // Pre-flight discovery: search for relevant tools based on the user's message
      const enabledSlugs = capabilities
        .map((c) => c.slug)
        .filter((slug) => !ALWAYS_ON_CAPABILITY_SLUGS.includes(slug))
      const preflightResults = await toolDiscoveryService.search(
        safeUserContent,
        enabledSlugs,
        PREFLIGHT_DISCOVERY_SCORE_THRESHOLD,
      )
      if (preflightResults.length) {
        for (const cap of preflightResults) {
          discoveredCapabilities.push({
            slug: cap.slug,
            name: cap.name,
            toolDefinitions: cap.tools,
            systemPrompt: cap.instructions,
            networkAccess: cap.networkAccess,
            skillType: cap.skillType,
          })
          for (const tool of cap.tools) {
            if (!tools.some((t) => t.name === tool.name)) {
              tools.push({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              })
            }
          }
        }
        const capPrompts = buildCapabilityBlocks(
          preflightResults.map((c) => ({
            name: c.name,
            systemPrompt: c.instructions,
          })),
        )
        systemPrompt += `\n\n${buildPromptSection('dynamically_loaded_capabilities', capPrompts)}`
        log.debugLog('Pre-flight discovery loaded', {
          slugs: preflightResults.map((c) => c.slug),
          toolsAdded: preflightResults.flatMap((c) => c.tools.map((t) => t.name)),
        })
      }
    } else {
      tools = capabilityService.buildToolDefinitions(capabilities)
      systemPrompt = capabilityService.buildSystemPrompt(capabilities, timezone)
    }

    // Remove delegation-only tools from the main agent (must use delegate_task instead)
    tools = tools.filter((t) => !DELEGATION_ONLY_TOOLS.has(t.name))

    // Inject document manifest so the model knows what's searchable
    const docs = await prisma.document.findMany({
      where: { workspaceId, status: 'READY' },
      select: { title: true, type: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_AGENT_DOCUMENTS,
    })
    if (docs.length) {
      const manifest = docs.map((d) => `- ${d.title} (${d.type})`).join('\n')
      systemPrompt += `\n\n${buildPromptSection(
        'workspace_documents',
        `The following ${docs.length} documents are available for search via search_documents:
${manifest}`,
      )}`
    }

    // Inject mandatory instruction when user explicitly mentioned capabilities
    if (options?.mentionedSlugs?.length) {
      const mentionedNames = options.mentionedSlugs
        .map((slug) => capabilities.find((c) => c.slug === slug)?.name ?? slug)
        .filter(Boolean)
      if (mentionedNames.length) {
        systemPrompt += `\n\n${buildPromptSection(
          'explicitly_requested_capabilities',
          `The user explicitly requested the following capabilities: ${mentionedNames.join(', ')}.
You MUST use the tools from these capabilities to fulfill this request. Do NOT substitute with other tools unless the requested tool fails or is clearly not applicable.`,
        )}`
      }
    }

    log.debugLog('Capabilities loaded', {
      count: capabilities.length,
      slugs: capabilities.map((c) => c.slug),
      toolCount: tools.length,
      toolNames: tools.map((t) => t.name),
      mentionedSlugs: options?.mentionedSlugs,
      discoveryMode: useDiscovery,
    })

    const llm = await createLLMProvider()

    // Load conversation history
    const history = await prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    })

    log.debugLog('History loaded', { messageCount: history.length })

    // Context compression — summarize older messages if context is too large
    const sessionData = await prisma.chatSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: {
        contextSummary: true,
        contextSummaryUpTo: true,
        lastInputTokens: true,
        sessionAllowRules: true,
      },
    })

    const contextLimitTokens = await settingsService.getContextLimitTokens()
    emit?.('compressing', { status: 'start' })
    const compressed = await compressContext(
      history,
      sessionData.contextSummary,
      sessionData.contextSummaryUpTo,
      sessionData.lastInputTokens,
      sessionId,
      contextLimitTokens,
    )

    if (compressed.compressed && compressed.lastSummarizedMessageId) {
      await prisma.chatSession.update({
        where: { id: sessionId },
        data: {
          contextSummary: compressed.summary,
          contextSummaryUpTo: compressed.lastSummarizedMessageId,
        },
      })
      const summarizedCount = history.length - compressed.recentMessages.length
      emit?.('compressing', {
        status: 'done',
        summarizedCount,
        keptCount: compressed.recentMessages.length,
      })
      log.debugLog('Context compressed', {
        summarizedCount,
        keptCount: compressed.recentMessages.length,
      })
    } else {
      emit?.('compressing', { status: 'skipped' })
    }

    const messages = buildConversationMessages({
      systemPrompt,
      summary: compressed.summary,
      recentMessages: compressed.recentMessages.map((message) => ({
        role: message.role as ChatMessage['role'],
        content: message.content,
      })),
      currentUserContent: safeUserContent,
      historyIncludesCurrentUserMessage: options?.historyIncludesCurrentUserMessage,
    })

    log.debugLog('Messages prepared', {
      totalMessages: messages.length,
      systemPromptLength: systemPrompt.length,
    })

    const toolExecutionLog: AgentResult['toolExecutions'] = []
    const collectedSources: NonNullable<AgentResult['sources']> = []
    let accumulatedContent = ''
    let lastSavedMessageId: string | undefined

    // Determine if we need a sandbox
    // In discovery mode, always start sandbox since discovered tools may need it
    const allToolNames = tools.map((t) => t.name)
    const needsSandbox = useDiscovery || toolExecutorService.needsSandbox(allToolNames)

    log.debugLog('Sandbox check', { needsSandbox, allToolNames })

    let sandboxReady = false

    if (needsSandbox) {
      emit?.('thinking', { message: 'Starting sandbox environment...' })

      const needsNetwork = capabilities.some((c) => c.networkAccess)
      const needsDockerSocket = capabilities.some((c) => c.slug === 'docker')

      const configEnvVars =
        await capabilityService.getDecryptedCapabilityConfigsForWorkspace(workspaceId)
      const mergedEnvVars: Record<string, string> = {}
      for (const envMap of configEnvVars.values()) {
        Object.assign(mergedEnvVars, envMap)
      }

      await sandboxService.getOrCreateWorkspaceContainer(
        workspaceId,
        { networkAccess: needsNetwork, dockerSocket: needsDockerSocket },
        Object.keys(mergedEnvVars).length ? mergedEnvVars : undefined,
      )
      sandboxReady = true
      const secretEnvRefs = [
        ...new Set(
          inventory.references.filter((ref) => ref.transport === 'env').map((ref) => ref.alias),
        ),
      ].sort()

      // Inject sandbox context into system prompt so the LLM knows writable paths
      const sandboxContext = `\n\n${buildPromptSection(
        'sandbox_environment',
        `Username: root
Working directory (cwd): /workspace/. All relative paths resolve here.
Shared outputs: /workspace/.outputs/ (writable)
When using sourcePath in generate_file, use the full path: /workspace/filename or /workspace/.outputs/filename` +
          (inventory.enabled && secretEnvRefs.length
            ? `\nAvailable secret env references (values hidden): ${secretEnvRefs.join(', ')}`
            : ''),
      )}`
      ;(messages[0] as { content: string }).content += sandboxContext
    }

    // Load auto-approve rules (global + session-scoped)
    const globalSettings = await prisma.globalSettings.findUnique({ where: { id: 'singleton' } })
    const globalRules = (globalSettings?.autoApproveRules as string[]) ?? []
    const sessionRules = (sessionData.sessionAllowRules as string[]) ?? []
    const allowRules: string[] = [...globalRules, ...sessionRules]

    const maxIterations = await settingsService.getMaxAgentIterations()
    for (let i = 0; i < maxIterations; i++) {
      if (options?.signal?.aborted) {
        throw new DOMException('Agent loop aborted by user', 'AbortError')
      }

      log.debugLog(`── Iteration ${i + 1}/${maxIterations} ──`)
      emit?.('thinking', { message: 'Thinking...' })

      // Prune old tool results to reduce context size
      const prunedCount = pruneOldToolResults(messages, i)
      if (prunedCount > 0) {
        log.debugLog('Pruned old tool results', { prunedCount, iteration: i + 1 })
      }

      log.logLLMRequest(messages, tools, i + 1)
      const llmStart = Date.now()
      const response = await llm.chatWithTools(messages, { tools })
      const llmMs = Date.now() - llmStart
      log.logLLMResponse(response, llmMs, i + 1)

      await recordTokenUsage(response.usage, sessionId, llm.providerId, llm.modelId)
      const safeResponseContent = secretRedactionService.redactForPublicStorage(
        response.content || '',
        inventory,
      )
      const safeResponseToolCalls = redactAssistantToolCalls(response.toolCalls, inventory)

      log.debugLog('LLM response', {
        durationMs: llmMs,
        finishReason: response.finishReason,
        contentLength: safeResponseContent.length,
        contentPreview: safeResponseContent.slice(0, 300) || '(empty)',
        toolCallCount: safeResponseToolCalls?.length ?? 0,
        toolCalls: safeResponseToolCalls?.map((tc) => ({
          id: tc.id,
          name: tc.name,
          args: JSON.stringify(tc.arguments).slice(0, 200),
        })),
      })

      // Log tool call argument sizes for debugging large LLM outputs
      if (response.toolCalls?.length) {
        for (const tc of response.toolCalls) {
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

      // No tool calls — we're done
      if (response.finishReason === 'stop' || !response.toolCalls?.length) {
        log.debugLog('Agent loop DONE (no more tool calls)', {
          totalToolExecutions: toolExecutionLog.length,
          finalContentLength: safeResponseContent.length,
        })

        // Deduplicate: if the final response is substantially similar to already-emitted
        // content (common when LLM repeats itself after a tool like generate_file), skip it
        const isDuplicate =
          accumulatedContent.trim().length > 0 &&
          safeResponseContent.trim().length > 0 &&
          contentOverlapRatio(accumulatedContent, safeResponseContent) > 0.5

        if (isDuplicate) {
          log.debugLog('Skipping duplicate final content', {
            accumulatedLength: accumulatedContent.length,
            finalLength: safeResponseContent.length,
          })
        } else {
          emit?.('content', { text: safeResponseContent })
        }

        const finalContent = isDuplicate
          ? accumulatedContent.trim()
          : (accumulatedContent + safeResponseContent).trim()

        // Save final assistant message to DB (only if non-duplicate and non-empty)
        if (!isDuplicate && safeResponseContent.trim()) {
          try {
            const finalMsg = await prisma.chatMessage.create({
              data: {
                sessionId,
                role: 'assistant',
                content: stripNullBytes(safeResponseContent),
                ...(collectedSources.length ? { sources: collectedSources } : {}),
              },
            })
            lastSavedMessageId = finalMsg.id
            log.debugLog('Saved final message', { messageId: finalMsg.id })
          } catch (saveErr) {
            console.error('[Agent] Failed to save final message:', saveErr)
          }
        }

        return {
          content: finalContent,
          toolExecutions: toolExecutionLog,
          sources: collectedSources.length ? collectedSources : undefined,
          lastMessageId: lastSavedMessageId,
        }
      }

      // Emit intermediate content so the user sees what the LLM is explaining between tool calls
      if (safeResponseContent.trim()) {
        emit?.('content', { text: safeResponseContent })
        accumulatedContent += safeResponseContent + '\n\n'
      }

      // Add assistant message with tool calls to conversation
      messages.push({
        role: 'assistant',
        content: safeResponseContent,
        toolCalls: safeResponseToolCalls,
      })

      // ── Helper: resolve capability for a tool call ──
      const resolveCapability = (toolCall: ToolCall) => {
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

      // ── Helper: run pre-checks (discovery, permission, size) — returns null if OK, or stops the loop ──
      const preCheckTool = async (
        toolCall: ToolCall,
        capabilitySlug: string,
        matchedCapability: ExecutableCapability | undefined,
        publicToolArgs: Record<string, unknown>,
      ) => {
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

        if (!isAllowed && !options?.autoApprove) {
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
            ...resolveSubAgentMeta(toolCall, capabilities),
          })

          const agentState: AgentState = {
            messages,
            iteration: i,
            pendingToolCalls: response.toolCalls ?? [],
            completedToolResults: [],
            toolExecutionLog,
            workspaceId,
            sessionId,
            discoveredCapabilitySlugs: discoveredCapabilities.map((c) => c.slug),
            mentionedSlugs: options?.mentionedSlugs,
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
          emit?.('awaiting_approval', { approvalIds: pendingApprovals.map((a) => a.id) })
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

      // ── Helper: execute a single tool ──
      const executeSingleTool = async (
        toolCall: ToolCall,
        capabilitySlug: string,
        matchedCapability: ExecutableCapability | undefined,
        publicToolArgs: Record<string, unknown>,
      ) => {
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
                skillType: (matchedCapability as Record<string, unknown>).skillType as
                  | string
                  | null,
                toolDefinitions: matchedCapability.toolDefinitions,
              }
            : undefined,
          emit,
          capabilities,
          mentionedSlugs: options?.mentionedSlugs,
          signal: options?.signal,
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

      // ── Execute tool calls (parallel-safe tools run concurrently) ──
      // First pass: pre-check all tools, collect those ready to execute
      type ReadyTool = {
        toolCall: ToolCall
        capabilitySlug: string
        matchedCapability: ExecutableCapability | undefined
        publicToolArgs: Record<string, unknown>
      }
      const readyTools: ReadyTool[] = []
      let paused = false

      for (const toolCall of response.toolCalls) {
        const { matchedCapability, capabilitySlug } = resolveCapability(toolCall)
        const publicToolArgs = secretRedactionService.redactForPublicStorage(
          toolCall.arguments,
          inventory,
        )
        const checkResult = await preCheckTool(
          toolCall,
          capabilitySlug,
          matchedCapability,
          publicToolArgs,
        )
        if (checkResult === 'paused') {
          paused = true
          break
        }
        if (checkResult === 'rejected') continue
        readyTools.push({ toolCall, capabilitySlug, matchedCapability, publicToolArgs })
      }

      if (paused) {
        // Save the intermediate content before pausing for approval
        if (safeResponseContent.trim()) {
          try {
            const pauseMsg = await prisma.chatMessage.create({
              data: { sessionId, role: 'assistant', content: stripNullBytes(safeResponseContent) },
            })
            lastSavedMessageId = pauseMsg.id
          } catch {
            /* best effort */
          }
        }
        return {
          paused: true,
          content: accumulatedContent.trim(),
          toolExecutions: toolExecutionLog,
          sources: collectedSources.length ? collectedSources : undefined,
          lastMessageId: lastSavedMessageId,
        }
      }

      // Second pass: execute — parallel-safe tools concurrently, others sequentially
      const parallelBatch = readyTools.filter((t) => PARALLEL_SAFE_TOOLS.has(t.toolCall.name))
      const sequentialBatch = readyTools.filter((t) => !PARALLEL_SAFE_TOOLS.has(t.toolCall.name))

      // Collect execution IDs for this iteration (for DB linking)
      const iterationExecutionIds: string[] = []

      // Execute parallel-safe tools concurrently (only worth it for 2+)
      const executeAndProcess = async (batch: ReadyTool[], parallel: boolean) => {
        if (batch.length === 0) return

        const results =
          parallel && batch.length > 1
            ? await Promise.all(
                batch.map((t) =>
                  executeSingleTool(
                    t.toolCall,
                    t.capabilitySlug,
                    t.matchedCapability,
                    t.publicToolArgs,
                  ),
                ),
              )
            : []

        for (let idx = 0; idx < batch.length; idx++) {
          const { toolCall, capabilitySlug, publicToolArgs } = batch[idx]
          const result =
            parallel && batch.length > 1
              ? results[idx]
              : await executeSingleTool(
                  toolCall,
                  capabilitySlug,
                  batch[idx].matchedCapability,
                  publicToolArgs,
                )

          // ── Post-process: SSE events, discovery injection, message push ──
          const isDiscoveryTool = toolCall.name === 'discover_tools'

          if (isDiscoveryTool) {
            let discoveryOutput = result.output || 'No tools discovered'
            try {
              const parsed = JSON.parse(result.output ?? '{}')
              if (parsed.discovered?.length) {
                discoveryOutput =
                  'Discovered: ' + parsed.discovered.map((c: { name: string }) => c.name).join(', ')
              }
            } catch {
              /* keep raw output */
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
              if (!collectedSources.some((cs) => cs.documentId === s.documentId))
                collectedSources.push(s)
            }
            emit?.('sources', { sources: collectedSources })
          }

          // Dynamic tool injection from discover_tools
          if (toolCall.name === 'discover_tools' && useDiscovery && result.output) {
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
                    if (
                      !tools.some((t) => t.name === tool.name) &&
                      !DELEGATION_ONLY_TOOLS.has(tool.name)
                    ) {
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
                log.debugLog('Tools dynamically injected', {
                  newSlugs: newCaps.map((c: { slug: string }) => c.slug),
                  skippedDuplicates: parsed.discovered.length - newCaps.length,
                  totalTools: tools.length,
                })
              }
            } catch {
              /* Discovery output parse failed */
            }
          }

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
          if (result.executionId) iterationExecutionIds.push(result.executionId)
          if (result.subAgentExecutionIds?.length) {
            iterationExecutionIds.push(...result.subAgentExecutionIds)
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
              ? buildToolResultContent(toolContent, llm.modelId)
              : toolContent
          messages.push({ role: 'tool', toolCallId: toolCall.id, content: messageContent })
        }
      }

      // Execute parallel-safe tools first (concurrently), then sequential ones
      if (parallelBatch.length > 1) {
        log.debugLog('Executing parallel batch', {
          tools: parallelBatch.map((t) => t.toolCall.name),
        })
      }
      await executeAndProcess(parallelBatch, true)
      await executeAndProcess(sequentialBatch, false)

      // ── Per-iteration DB persistence: save this iteration's assistant message ──
      try {
        const iterContent = safeResponseContent
        const allIterTools = [...readyTools]
        // Also include rejected tools from pre-check that were logged
        const iterToolCalls = allIterTools.map((rt) => ({
          name: rt.toolCall.name,
          capability: rt.capabilitySlug,
          input: rt.publicToolArgs,
        }))

        // Build contentBlocks for THIS iteration
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
        if (iterContent.trim()) {
          iterBlocks.push({ type: 'text', text: iterContent })
        }
        // Get the most recent toolExecutionLog entries for this iteration
        const iterLogEntries = toolExecutionLog.slice(-allIterTools.length)
        for (let t = 0; t < allIterTools.length; t++) {
          const rt = allIterTools[t]
          if (rt.toolCall.name === 'delegate_task') {
            const args = rt.toolCall.arguments as Record<string, unknown>
            const logEntry = iterLogEntries[t]
            iterBlocks.push({
              type: 'sub_agent',
              toolIndex: t,
              subAgentId: rt.toolCall.id,
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
          .slice(-allIterTools.length)
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
            content: stripNullBytes(iterContent),
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
        lastSavedMessageId = iterMsg.id

        // Link ToolExecution records directly by their IDs
        if (iterationExecutionIds.length) {
          await prisma.toolExecution.updateMany({
            where: { id: { in: iterationExecutionIds } },
            data: { chatMessageId: iterMsg.id },
          })
        }

        log.debugLog('Saved iteration message', {
          messageId: iterMsg.id,
          toolCount: allIterTools.length,
          executionIds: iterationExecutionIds.length,
        })
      } catch (saveErr) {
        console.error('[Agent] Failed to save iteration message:', saveErr)
      }
    }

    log.debugLog('Agent loop DONE (max iterations reached)', {
      totalToolExecutions: toolExecutionLog.length,
    })

    const maxIterContent =
      'I reached the maximum number of tool-calling iterations. Here is what I found so far based on the tool outputs above.'
    emit?.('content', { text: maxIterContent })

    // Save max-iterations message to DB
    try {
      const maxIterMsg = await prisma.chatMessage.create({
        data: { sessionId, role: 'assistant', content: stripNullBytes(maxIterContent) },
      })
      lastSavedMessageId = maxIterMsg.id
    } catch {
      /* best effort */
    }

    return {
      content: (accumulatedContent + maxIterContent).trim(),
      toolExecutions: toolExecutionLog,
      sources: collectedSources.length ? collectedSources : undefined,
      lastMessageId: lastSavedMessageId,
    }
  },

  /**
   * Resume agent loop after tool approval decisions.
   */
  async resumeAgentLoop(
    sessionId: string,
    emit?: SSEEmit,
    inventoryArg?: SecretInventory,
    signal?: AbortSignal,
  ): Promise<AgentResult> {
    const session = await prisma.chatSession.findUniqueOrThrow({
      where: { id: sessionId },
    })
    const inventory =
      inventoryArg ?? (await secretRedactionService.buildSecretInventory(session.workspaceId))
    const log = createSessionLogger(sessionId, inventory)
    log.debugLog('resumeAgentLoop START', { sessionId })

    const state = deserializeAgentState(session)
    if (!state) {
      throw new Error('No agent state to resume')
    }

    // Get all decided approvals
    const approvals = await prisma.toolApproval.findMany({
      where: { chatSessionId: sessionId },
      orderBy: { createdAt: 'asc' },
    })

    log.debugLog('Resuming with approvals', {
      totalApprovals: approvals.length,
      decisions: approvals.map((a) => ({ tool: a.toolName, status: a.status })),
      pendingToolCalls: state.pendingToolCalls.map((tc) => tc.name),
      iteration: state.iteration,
    })

    const pendingApprovals = approvals.filter((a) => a.status === 'pending')
    if (pendingApprovals.length > 0) {
      throw new Error('Not all approvals have been decided')
    }

    // Clear agent state
    await prisma.chatSession.update({
      where: { id: sessionId },
      data: { agentState: Prisma.DbNull, agentStateEncrypted: null, agentStatus: 'running' },
    })

    const { messages, toolExecutionLog, workspaceId } = state
    const collectedSourcesResume: NonNullable<AgentResult['sources']> = []
    let lastSavedMessageId: string | undefined
    let resumeAccumulatedContent = ''

    // Check if any tool was denied — if so, stop immediately
    const hasDenied = state.pendingToolCalls.some((tc) => {
      const a = approvals.find((ap) => ap.toolCallId === tc.id)
      return a?.status === 'denied'
    })

    if (hasDenied) {
      const deniedNames = state.pendingToolCalls
        .filter((tc) => approvals.find((a) => a.toolCallId === tc.id)?.status === 'denied')
        .map((tc) => tc.name)

      log.debugLog('Agent STOPPED — tool(s) denied', { deniedNames })

      await prisma.toolApproval.deleteMany({
        where: { chatSessionId: sessionId },
      })

      await prisma.chatSession.update({
        where: { id: sessionId },
        data: { agentStatus: 'idle' },
      })

      const rejectionContent = `Action skipped — ${deniedNames.join(', ')} was not approved.`
      emit?.('content', { text: rejectionContent })

      try {
        const deniedMsg = await prisma.chatMessage.create({
          data: { sessionId, role: 'assistant', content: stripNullBytes(rejectionContent) },
        })
        lastSavedMessageId = deniedMsg.id
      } catch {
        /* best effort */
      }

      return {
        content: rejectionContent,
        toolExecutions: toolExecutionLog,
        sources: collectedSourcesResume.length ? collectedSourcesResume : undefined,
        lastMessageId: lastSavedMessageId,
      }
    }

    // Pre-load capabilities for resume execution
    const resumeCapabilities =
      await capabilityService.getEnabledCapabilitiesForWorkspace(workspaceId)

    // Process approved tool calls — parallel-safe tools concurrently, others sequentially
    const resumeExecutionIds: string[] = []

    // Pre-resolve capabilities and args for all pending tool calls
    const resolvedPending = state.pendingToolCalls.map((toolCall) => {
      const publicToolArgs = secretRedactionService.redactForPublicStorage(
        toolCall.arguments,
        inventory,
      )
      const approval = approvals.find((a) => a.toolCallId === toolCall.id)
      const resumeMatchedCap = resumeCapabilities.find((cap) => {
        const defs = cap.toolDefinitions as Array<{ name: string }>
        return defs?.some((t) => t.name === toolCall.name)
      })
      const capabilitySlug = resumeMatchedCap?.slug ?? approval?.capabilitySlug ?? 'unknown'
      return { toolCall, publicToolArgs, resumeMatchedCap, capabilitySlug }
    })

    // Helper: execute a single approved tool and return its result
    const executeApprovedTool = (r: (typeof resolvedPending)[number]) => {
      const { toolCall, publicToolArgs, resumeMatchedCap, capabilitySlug } = r
      const isDiscoveryToolResume = toolCall.name === 'discover_tools'
      if (isDiscoveryToolResume) {
        emit?.('thinking', { message: 'Looking for the right tools...' })
      } else {
        emit?.('tool_start', {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          capabilitySlug,
          input: publicToolArgs,
        })
      }
      return toolExecutorService.execute(toolCall, capabilitySlug, {
        workspaceId,
        chatSessionId: sessionId,
        secretInventory: inventory,
        capability: resumeMatchedCap
          ? {
              slug: resumeMatchedCap.slug,
              skillType: (resumeMatchedCap as Record<string, unknown>).skillType as string | null,
              toolDefinitions: resumeMatchedCap.toolDefinitions,
            }
          : undefined,
        emit,
        capabilities: resumeCapabilities,
        mentionedSlugs: state.mentionedSlugs,
        signal,
      })
    }

    // Helper: post-process a tool result (SSE, logging, messages)
    const postProcessApprovedTool = async (
      r: (typeof resolvedPending)[number],
      result: ExecutionResult,
    ) => {
      const { toolCall } = r
      const isDiscoveryToolResume = toolCall.name === 'discover_tools'

      log.logToolResult(toolCall.name, result)
      if (!isDiscoveryToolResume) {
        const resumeSsePayload = prepareToolResultForSSE(toolCall.name, result)
        emit?.('tool_result', {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          ...resumeSsePayload,
          error: result.error,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        })
      }

      if (result.executionId) resumeExecutionIds.push(result.executionId)
      if (result.subAgentExecutionIds?.length) {
        resumeExecutionIds.push(...result.subAgentExecutionIds)
      }

      // Truncate large sandbox outputs to save context
      const rawContent =
        toolCall.name === 'run_browser_script'
          ? result.output
          : result.error
            ? `Error: ${result.error}\n\n${result.output}`
            : result.output
      const isSandboxTool = !NON_SANDBOX_TOOLS.has(toolCall.name)
      const toolContent =
        workspaceId && isSandboxTool
          ? await maybeTruncateOutput(rawContent, toolCall.id, workspaceId)
          : rawContent
      messages.push({
        role: 'tool',
        toolCallId: toolCall.id,
        content: toolContent,
      })
    }

    // Launch parallel-safe tools concurrently, collect results keyed by toolCall.id
    const parallelPending = resolvedPending.filter((r) => PARALLEL_SAFE_TOOLS.has(r.toolCall.name))
    const resultMap = new Map<string, ExecutionResult>()
    if (parallelPending.length > 1) {
      log.debugLog('Executing parallel batch (resume)', {
        tools: parallelPending.map((r) => r.toolCall.name),
      })
      const parallelResults = await Promise.all(parallelPending.map(executeApprovedTool))
      for (let idx = 0; idx < parallelPending.length; idx++) {
        resultMap.set(parallelPending[idx].toolCall.id, parallelResults[idx])
      }
    }

    // Iterate in original order — parallel results are already available, sequential ones execute inline
    for (const r of resolvedPending) {
      const result = resultMap.get(r.toolCall.id) ?? (await executeApprovedTool(r))
      await postProcessApprovedTool(r, result)

      // Push to toolExecutionLog in original order (needed for contentBlocks toolIndex mapping)
      toolExecutionLog.push({
        toolName: r.toolCall.name,
        capabilitySlug: r.capabilitySlug,
        input: r.publicToolArgs,
        output: result.output || undefined,
        error: result.error,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        subAgentExecutionIds: result.subAgentExecutionIds,
      })
    }

    // Save the approved tool calls as a ChatMessage (these are the tools that were awaiting approval)
    if (state.pendingToolCalls.length > 0) {
      try {
        const approvedToolCalls = state.pendingToolCalls.map((tc) => ({
          name: tc.name,
          capability: approvals.find((a) => a.toolCallId === tc.id)?.capabilitySlug ?? 'unknown',
          input: secretRedactionService.redactForPublicStorage(tc.arguments, inventory),
        }))
        const approvedBlocks: Array<
          | { type: 'tool'; toolIndex: number }
          | {
              type: 'sub_agent'
              toolIndex: number
              subAgentId: string
              role: string
              task: string
              subToolIds?: string[]
            }
        > = state.pendingToolCalls.map((tc, idx) => {
          if (tc.name === 'delegate_task') {
            const args = tc.arguments as Record<string, unknown>
            const logEntry = toolExecutionLog[idx]
            return {
              type: 'sub_agent' as const,
              toolIndex: idx,
              subAgentId: tc.id,
              role: String(args.role ?? 'execute'),
              task: String(args.task ?? ''),
              subToolIds: logEntry?.subAgentExecutionIds,
            }
          }
          return {
            type: 'tool' as const,
            toolIndex: idx,
          }
        })
        const approvedMsg = await prisma.chatMessage.create({
          data: {
            sessionId,
            role: 'assistant',
            content: '',
            toolCalls: JSON.parse(JSON.stringify(approvedToolCalls)) as Prisma.InputJsonValue,
            contentBlocks: approvedBlocks as unknown as Prisma.InputJsonValue,
          },
        })
        lastSavedMessageId = approvedMsg.id
        if (resumeExecutionIds.length) {
          await prisma.toolExecution.updateMany({
            where: { id: { in: resumeExecutionIds } },
            data: { chatMessageId: approvedMsg.id },
          })
        }
      } catch (saveErr) {
        console.error('[Agent] Failed to save approved tools message:', saveErr)
      }
    }

    // LLM needed below for multimodal handling
    const llm = await createLLMProvider()

    // Clean up approvals
    await prisma.toolApproval.deleteMany({
      where: { chatSessionId: sessionId },
    })

    // Continue the agent loop from where we left off (reuse pre-loaded capabilities)
    const capabilities = resumeCapabilities
    // Remove delegation-only tools from the main agent (must use delegate_task instead)
    const tools = capabilityService
      .buildToolDefinitions(capabilities)
      .filter((t) => !DELEGATION_ONLY_TOOLS.has(t.name))

    // Load auto-approve rules (global + session-scoped) and workspace auto-execute flag
    const resumeSettings = await prisma.globalSettings.findUnique({ where: { id: 'singleton' } })
    const resumeGlobalRules = (resumeSettings?.autoApproveRules as string[]) ?? []
    const resumeSession = await prisma.chatSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { sessionAllowRules: true },
    })
    const resumeSessionRules = (resumeSession.sessionAllowRules as string[]) ?? []
    const allowRules: string[] = [...resumeGlobalRules, ...resumeSessionRules]
    const resumeWorkspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: state.workspaceId },
      select: { autoExecute: true },
    })
    const autoApprove = resumeWorkspace.autoExecute

    const maxIterations = await settingsService.getMaxAgentIterations()
    for (let i = state.iteration; i < maxIterations; i++) {
      if (signal?.aborted) {
        throw new DOMException('Agent loop aborted by user', 'AbortError')
      }

      emit?.('thinking', { message: 'Thinking...' })

      // Prune old tool results to reduce context size
      const prunedCount = pruneOldToolResults(messages, i)
      if (prunedCount > 0) {
        log.debugLog('Pruned old tool results (resume)', { prunedCount, iteration: i + 1 })
      }

      log.logLLMRequest(messages, tools, i + 1)
      const llmStart = Date.now()
      const response = await llm.chatWithTools(messages, { tools })
      const llmMs = Date.now() - llmStart
      log.logLLMResponse(response, llmMs, i + 1)

      await recordTokenUsage(response.usage, sessionId, llm.providerId, llm.modelId)
      const safeResponseContent = secretRedactionService.redactForPublicStorage(
        response.content || '',
        inventory,
      )
      const safeResponseToolCalls = redactAssistantToolCalls(response.toolCalls, inventory)

      log.debugLog('LLM response (resume)', {
        durationMs: llmMs,
        finishReason: response.finishReason,
        contentLength: safeResponseContent.length,
        toolCallCount: safeResponseToolCalls?.length ?? 0,
      })

      // Log tool call argument sizes for debugging large LLM outputs
      if (response.toolCalls?.length) {
        for (const tc of response.toolCalls) {
          const argsStr = JSON.stringify(tc.arguments)
          const argsSize = argsStr.length
          const commandArg = tc.arguments?.command ?? tc.arguments?.code ?? tc.arguments?.content
          const commandSize = typeof commandArg === 'string' ? commandArg.length : 0
          log.debugLog(`[TOOL_SIZE] ${tc.name}`, {
            totalArgsChars: argsSize,
            commandChars: commandSize,
            linesInCommand: typeof commandArg === 'string' ? commandArg.split('\n').length : 0,
            isLarge: argsSize > LARGE_TOOL_ARG_THRESHOLD,
          })
          if (argsSize > LARGE_TOOL_ARG_THRESHOLD) {
            log.debugLog(
              `[TOOL_SIZE_WARN] ${tc.name} generated ${argsSize} chars (${Math.round(argsSize / 1000)}KB) — possible data embedding`,
            )
          }
        }
      }

      if (response.finishReason === 'stop' || !response.toolCalls?.length) {
        // Deduplicate: skip if final response repeats already-emitted content
        const isDuplicateResume =
          resumeAccumulatedContent.trim().length > 0 &&
          safeResponseContent.trim().length > 0 &&
          contentOverlapRatio(resumeAccumulatedContent, safeResponseContent) > 0.5

        if (isDuplicateResume) {
          log.debugLog('Skipping duplicate final content (resume)', {
            accumulatedLength: resumeAccumulatedContent.length,
            finalLength: safeResponseContent.length,
          })
        } else {
          emit?.('content', { text: safeResponseContent })
        }

        // Save final message (only if non-duplicate and non-empty)
        if (!isDuplicateResume && safeResponseContent.trim()) {
          try {
            const finalMsg = await prisma.chatMessage.create({
              data: {
                sessionId,
                role: 'assistant',
                content: stripNullBytes(safeResponseContent),
                ...(collectedSourcesResume.length ? { sources: collectedSourcesResume } : {}),
              },
            })
            lastSavedMessageId = finalMsg.id
          } catch {
            /* best effort */
          }
        }

        await prisma.chatSession.update({
          where: { id: sessionId },
          data: { agentStatus: 'idle' },
        })

        return {
          content: isDuplicateResume
            ? resumeAccumulatedContent.trim()
            : safeResponseContent,
          toolExecutions: toolExecutionLog,
          sources: collectedSourcesResume.length ? collectedSourcesResume : undefined,
          lastMessageId: lastSavedMessageId,
        }
      }

      // Emit intermediate content so the user sees what the LLM is explaining between tool calls
      if (safeResponseContent.trim()) {
        emit?.('content', { text: safeResponseContent })
        resumeAccumulatedContent += safeResponseContent + '\n\n'
      }

      messages.push({
        role: 'assistant',
        content: safeResponseContent,
        toolCalls: safeResponseToolCalls,
      })

      const resumeLoopExecIds: string[] = []

      // ── First pass: pre-check all tools (permissions, size) ──
      type ResumeReadyTool = {
        toolCall: ToolCall
        capabilitySlug: string
        matchedCap: (typeof capabilities)[0] | undefined
        publicToolArgs: Record<string, unknown>
      }
      const resumeReadyTools: ResumeReadyTool[] = []
      let resumePaused = false

      for (const toolCall of response.toolCalls) {
        const publicToolArgs = secretRedactionService.redactForPublicStorage(
          toolCall.arguments,
          inventory,
        )
        const matchedCap = capabilities.find((cap) => {
          const defs = cap.toolDefinitions as Array<{ name: string }>
          return defs?.some((t) => t.name === toolCall.name)
        })
        const capabilitySlug = matchedCap?.slug ?? 'unknown'

        if (!permissionService.isToolAllowed(toolCall, allowRules) && !autoApprove) {
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
            ...resolveSubAgentMeta(toolCall, capabilities),
          })

          const agentState: AgentState = {
            messages,
            iteration: i,
            pendingToolCalls: response.toolCalls,
            completedToolResults: [],
            toolExecutionLog,
            workspaceId,
            sessionId,
            mentionedSlugs: state.mentionedSlugs,
          }

          await prisma.chatSession.update({
            where: { id: sessionId },
            data: {
              agentState: buildPublicAgentState(agentState, inventory) as Prisma.InputJsonValue,
              agentStateEncrypted: serializeEncryptedAgentState(agentState),
              agentStatus: 'awaiting_approval',
            },
          })

          const pending = await prisma.toolApproval.findMany({
            where: { chatSessionId: sessionId, status: 'pending' },
            select: { id: true },
          })

          emit?.('awaiting_approval', { approvalIds: pending.map((a) => a.id) })
          resumePaused = true
          break
        }

        // Guard: reject oversized tool call arguments
        const sizeRejection = checkToolArgSize(toolCall)
        if (sizeRejection) {
          log.debugLog(`[BLOCKED] "${toolCall.name}" — args too large (resume)`, {
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
          continue
        }

        resumeReadyTools.push({ toolCall, capabilitySlug, matchedCap, publicToolArgs })
      }

      if (resumePaused) {
        return {
          paused: true,
          content: '',
          toolExecutions: toolExecutionLog,
          sources: collectedSourcesResume.length ? collectedSourcesResume : undefined,
          lastMessageId: lastSavedMessageId,
        }
      }

      // ── Second pass: execute with parallel batching ──
      const resumeParallelBatch = resumeReadyTools.filter((t) =>
        PARALLEL_SAFE_TOOLS.has(t.toolCall.name),
      )
      const resumeSequentialBatch = resumeReadyTools.filter(
        (t) => !PARALLEL_SAFE_TOOLS.has(t.toolCall.name),
      )

      const executeResumeAndProcess = async (batch: ResumeReadyTool[], parallel: boolean) => {
        if (batch.length === 0) return

        const results =
          parallel && batch.length > 1
            ? await Promise.all(
                batch.map((t) => {
                  emit?.('tool_start', {
                    toolCallId: t.toolCall.id,
                    toolName: t.toolCall.name,
                    capabilitySlug: t.capabilitySlug,
                    input: t.publicToolArgs,
                  })
                  return toolExecutorService.execute(t.toolCall, t.capabilitySlug, {
                    workspaceId,
                    chatSessionId: sessionId,
          
                    secretInventory: inventory,
                    capability: t.matchedCap
                      ? {
                          slug: t.matchedCap.slug,
                          skillType: (t.matchedCap as Record<string, unknown>).skillType as
                            | string
                            | null,
                          toolDefinitions: t.matchedCap.toolDefinitions,
                        }
                      : undefined,
                    emit,
                    capabilities,
                    mentionedSlugs: state.mentionedSlugs,
                    signal,
                  })
                }),
              )
            : []

        for (let idx = 0; idx < batch.length; idx++) {
          const { toolCall, capabilitySlug, matchedCap, publicToolArgs } = batch[idx]

          const isDiscoveryToolLoop = toolCall.name === 'discover_tools'
          if (!parallel || batch.length <= 1) {
            if (isDiscoveryToolLoop) {
              emit?.('thinking', { message: 'Looking for the right tools...' })
            } else {
              emit?.('tool_start', {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                capabilitySlug,
                input: publicToolArgs,
              })
            }
          }

          const result =
            parallel && batch.length > 1
              ? results[idx]
              : await toolExecutorService.execute(toolCall, capabilitySlug, {
                  workspaceId,
                  chatSessionId: sessionId,
        
                  secretInventory: inventory,
                  capability: matchedCap
                    ? {
                        slug: matchedCap.slug,
                        skillType: (matchedCap as Record<string, unknown>).skillType as
                          | string
                          | null,
                        toolDefinitions: matchedCap.toolDefinitions,
                      }
                    : undefined,
                  emit,
                  capabilities,
                  mentionedSlugs: state.mentionedSlugs,
                  signal,
                })

          log.logToolResult(toolCall.name, result)
          if (!isDiscoveryToolLoop) {
            const resumeLoopSsePayload = prepareToolResultForSSE(toolCall.name, result)
            emit?.('tool_result', {
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              ...resumeLoopSsePayload,
              error: result.error,
              exitCode: result.exitCode,
              durationMs: result.durationMs,
            })
          }

          // Collect document sources from search_documents
          if (result.sources?.length) {
            for (const s of result.sources) {
              if (!collectedSourcesResume.some((cs) => cs.documentId === s.documentId)) {
                collectedSourcesResume.push(s)
              }
            }
            emit?.('sources', { sources: collectedSourcesResume })
          }

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
          if (result.executionId) resumeLoopExecIds.push(result.executionId)
          if (result.subAgentExecutionIds?.length) {
            resumeLoopExecIds.push(...result.subAgentExecutionIds)
          }

          // Truncate large outputs to save context
          const rawContent =
            toolCall.name === 'run_browser_script'
              ? result.output
              : result.error
                ? `Error: ${result.error}\n\n${result.output}`
                : result.output
          const isSandboxTool = !NON_SANDBOX_TOOLS.has(toolCall.name)
          // Sandbox is always ready when resuming (it was set up during the initial runAgentLoop)
          const toolContent = isSandboxTool
            ? await maybeTruncateOutput(rawContent, toolCall.id, workspaceId)
            : rawContent
          const resumeMessageContent: MessageContent =
            toolCall.name === 'run_browser_script'
              ? buildToolResultContent(toolContent, llm.modelId)
              : toolContent
          messages.push({
            role: 'tool',
            toolCallId: toolCall.id,
            content: resumeMessageContent,
          })
        }
      }

      await executeResumeAndProcess(resumeParallelBatch, true)
      await executeResumeAndProcess(resumeSequentialBatch, false)

      // ── Per-iteration DB persistence (resume loop) ──
      try {
        const iterContent = safeResponseContent
        const iterToolCalls = response.toolCalls.map((tc) => {
          const cap = capabilities.find((c) =>
            (c.toolDefinitions as Array<{ name: string }>)?.some((t) => t.name === tc.name),
          )
          return {
            name: tc.name,
            capability: cap?.slug ?? 'unknown',
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
        if (iterContent.trim()) iterBlocks.push({ type: 'text', text: iterContent })
        const resumeIterLogEntries = toolExecutionLog.slice(-response.toolCalls.length)
        for (let t = 0; t < response.toolCalls.length; t++) {
          const tc = response.toolCalls[t]
          if (tc.name === 'delegate_task') {
            const args = tc.arguments as Record<string, unknown>
            const logEntry = resumeIterLogEntries[t]
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
        const iterMsg = await prisma.chatMessage.create({
          data: {
            sessionId,
            role: 'assistant',
            content: stripNullBytes(iterContent),
            toolCalls: iterToolCalls.length
              ? (JSON.parse(stripNullBytes(JSON.stringify(iterToolCalls))) as Prisma.InputJsonValue)
              : undefined,
            ...(iterBlocks.length
              ? { contentBlocks: iterBlocks as unknown as Prisma.InputJsonValue }
              : {}),
          },
        })
        lastSavedMessageId = iterMsg.id
        if (resumeLoopExecIds.length) {
          await prisma.toolExecution.updateMany({
            where: { id: { in: resumeLoopExecIds } },
            data: { chatMessageId: iterMsg.id },
          })
        }
      } catch (saveErr) {
        console.error('[Agent] Failed to save resume iteration message:', saveErr)
      }
    }

    await prisma.chatSession.update({
      where: { id: sessionId },
      data: { agentStatus: 'idle' },
    })

    const maxIterContent =
      'I reached the maximum number of tool-calling iterations. Here is what I found so far.'
    emit?.('content', { text: maxIterContent })

    try {
      const maxMsg = await prisma.chatMessage.create({
        data: { sessionId, role: 'assistant', content: stripNullBytes(maxIterContent) },
      })
      lastSavedMessageId = maxMsg.id
    } catch {
      /* best effort */
    }

    return {
      content: maxIterContent,
      toolExecutions: toolExecutionLog,
      sources: collectedSourcesResume.length ? collectedSourcesResume : undefined,
      lastMessageId: lastSavedMessageId,
    }
  },

  /**
   * Simple query interface for backward compatibility.
   */
  async run(query: string, context: { workspaceId: string }) {
    let session = await prisma.chatSession.findFirst({
      where: {
        workspaceId: context.workspaceId,
        title: '__agent_session__',
      },
    })

    if (!session) {
      session = await prisma.chatSession.create({
        data: {
          workspaceId: context.workspaceId,
          title: '__agent_session__',
        },
      })
    }

    const result = await this.runAgentLoop(session.id, query, context.workspaceId)

    return {
      answer: result.content,
      sources: [],
      toolExecutions: result.toolExecutions,
    }
  },
}
