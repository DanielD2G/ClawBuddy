import { prisma } from '../lib/prisma.js'
import { Prisma } from '@prisma/client'
import { createLLMProvider } from '../providers/index.js'
import type { ChatMessage, LLMProvider } from '../providers/llm.interface.js'
import type { SSEEmit } from '../lib/sse.js'
import { capabilityService } from './capability.service.js'
import {
  toolExecutorService,
  NON_SANDBOX_TOOLS,
  type ExecutionResult,
} from './tool-executor.service.js'
import { sandboxService } from './sandbox.service.js'
import { compressContext } from './context-compression.service.js'
import { settingsService } from './settings.service.js'
import {
  MAX_AGENT_DOCUMENTS,
  PREFLIGHT_DISCOVERY_SCORE_THRESHOLD,
  DELEGATION_ONLY_TOOLS,
  PARALLEL_SAFE_TOOLS,
} from '../constants.js'
import { toolDiscoveryService } from './tool-discovery.service.js'
import { stripNullBytes } from '../lib/sanitize.js'
import { retryProviderTimeoutOnce } from '../lib/llm-retry.js'
import { logger } from '../lib/logger.js'
import type { SecretInventory } from './secret-redaction.service.js'
import { secretRedactionService } from './secret-redaction.service.js'
import { buildConversationMessages } from './agent-message-builder.js'
import {
  pruneOldToolResults,
  prepareToolResultForSSE,
  maybeTruncateOutput,
} from './agent-tool-results.service.js'
import { createSessionLogger } from './agent-debug.service.js'
import type { SessionLogger } from './agent-debug.service.js'
import { buildCapabilityBlocks, buildPromptSection } from './system-prompt-builder.js'
import type { AgentResult } from './agent-state.service.js'
import { deserializeAgentState } from './agent-state.service.js'
import {
  buildSessionConversationState,
  getSessionAllowRules,
  getSessionLoadedCapabilitySlugs,
} from './session-state.service.js'
import { recordTokenUsage } from './agent-token.service.js'
import {
  mergeConversationLoadedCapabilitySlugs,
  stringArraysEqual,
  persistConversationLoadedCapabilitySlugs,
  buildConversationLoadedCapabilitiesSection,
} from './agent-conversation-state.js'
import {
  type ToolDispatchContext,
  redactAssistantToolCalls,
  logToolCallSizes,
  contentOverlapRatio,
  getEmptyFinalResponseFallback,
  executeToolCalls,
  persistIterationMessage,
} from './agent-tool-dispatch.js'

// Re-export for backward compatibility
export { recordTokenUsage } from './agent-token.service.js'
export { checkToolArgSize } from './agent-token.service.js'

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
    const enabledCapabilitySlugs = new Set(capabilities.map((cap) => cap.slug))

    const sessionData = await prisma.chatSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: {
        contextSummary: true,
        contextSummaryUpTo: true,
        lastInputTokens: true,
        sessionAllowRules: true,
      },
    })

    const storedConversationLoadedCapabilitySlugs = getSessionLoadedCapabilitySlugs(
      sessionData.sessionAllowRules,
    )
    let conversationLoadedCapabilitySlugs = mergeConversationLoadedCapabilitySlugs(
      storedConversationLoadedCapabilitySlugs,
      options?.mentionedSlugs,
      enabledCapabilitySlugs,
    )

    if (
      !stringArraysEqual(storedConversationLoadedCapabilitySlugs, conversationLoadedCapabilitySlugs)
    ) {
      await prisma.chatSession.update({
        where: { id: sessionId },
        data: {
          sessionAllowRules: buildSessionConversationState(sessionData.sessionAllowRules, {
            loadedCapabilitySlugs: conversationLoadedCapabilitySlugs,
          }),
        },
      })
    }

    // Track dynamically discovered capabilities during the agent loop
    const discoveredCapabilities: ToolDispatchContext['discoveredCapabilities'] = []

    const timezone = await settingsService.getTimezone()

    const ctx = toolDiscoveryService.buildDiscoveryContext(
      capabilities,
      conversationLoadedCapabilitySlugs,
      timezone,
    )
    let tools = ctx.tools
    let systemPrompt = ctx.systemPrompt
    log.debugLog('Discovery mode ACTIVE', {
      capabilityCount: capabilities.length,
      loadedTools: tools.map((t) => t.name),
      conversationLoadedCapabilitySlugs,
    })

    // Pre-flight discovery: search for relevant tools based on the user's message
    const enabledSlugs = capabilities
      .map((c) => c.slug)
      .filter(
        (slug) => slug !== 'tool-discovery' && !conversationLoadedCapabilitySlugs.includes(slug),
      )
    const preflightResults = enabledSlugs.length
      ? await toolDiscoveryService.search(
          safeUserContent,
          enabledSlugs,
          PREFLIGHT_DISCOVERY_SCORE_THRESHOLD,
        )
      : []
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
      conversationLoadedCapabilitySlugs = await persistConversationLoadedCapabilitySlugs(
        sessionId,
        conversationLoadedCapabilitySlugs,
        preflightResults.map((cap) => cap.slug),
        enabledCapabilitySlugs,
      )
      log.debugLog('Pre-flight discovery loaded', {
        slugs: preflightResults.map((c) => c.slug),
        toolsAdded: preflightResults.flatMap((c) => c.tools.map((t) => t.name)),
      })
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

    const conversationLoadedCapabilitiesSection = buildConversationLoadedCapabilitiesSection(
      conversationLoadedCapabilitySlugs,
      capabilities,
    )
    if (conversationLoadedCapabilitiesSection) {
      systemPrompt += `\n\n${conversationLoadedCapabilitiesSection}`
    }

    log.debugLog('Capabilities loaded', {
      count: capabilities.length,
      slugs: capabilities.map((c) => c.slug),
      toolCount: tools.length,
      toolNames: tools.map((t) => t.name),
      mentionedSlugs: options?.mentionedSlugs,
      conversationLoadedCapabilitySlugs,
    })

    const llm = await createLLMProvider()

    // Load conversation history
    const history = await prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    })

    log.debugLog('History loaded', { messageCount: history.length })

    // Context compression — summarize older messages if context is too large
    const workspaceData = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { permissions: true },
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

    // Discovery mode always needs a sandbox since discovered tools may need it
    const needsSandbox = true

    log.debugLog('Sandbox check', { needsSandbox })

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

    // Load auto-approve rules (workspace + session-scoped)
    const workspaceRules = (
      (workspaceData?.permissions as { allow?: string[] } | null)?.allow ?? []
    ).filter((rule): rule is string => typeof rule === 'string')
    const sessionRules = getSessionAllowRules(sessionData.sessionAllowRules)
    const allowRules: string[] = [...workspaceRules, ...sessionRules]

    // Build the shared dispatch context
    const dispatchCtx: ToolDispatchContext = {
      sessionId,
      workspaceId,
      inventory,
      emit,
      log,
      messages,
      toolExecutionLog,
      collectedSources,
      capabilities,
      tools,
      allowRules,
      autoApprove: options?.autoApprove,
      sandboxReady,
      modelId: llm.modelId,
      mentionedSlugs: options?.mentionedSlugs,
      signal: options?.signal,
      discoveredCapabilities,
      enabledCapabilitySlugs,
      conversationLoadedCapabilitySlugs,
    }

    let lastSavedMessageId: string | undefined

    const result = await runIterationLoop({
      dispatchCtx,
      llm,
      log,
      emit,
      sessionId,
      inventory,
      startIteration: 0,
      signal: options?.signal,
    })

    lastSavedMessageId = result.lastSavedMessageId

    if (result.paused) {
      // Save the intermediate content before pausing for approval
      if (result.pauseContent) {
        try {
          const pauseMsg = await prisma.chatMessage.create({
            data: { sessionId, role: 'assistant', content: stripNullBytes(result.pauseContent) },
          })
          lastSavedMessageId = pauseMsg.id
        } catch (err) {
          logger.warn('[Agent] Failed to save pause message', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      return {
        paused: true,
        content: result.accumulatedContent.trim(),
        toolExecutions: toolExecutionLog,
        sources: collectedSources.length ? collectedSources : undefined,
        lastMessageId: lastSavedMessageId,
      }
    }

    return {
      content: result.finalContent,
      toolExecutions: toolExecutionLog,
      sources: collectedSources.length ? collectedSources : undefined,
      lastMessageId: lastSavedMessageId ?? result.lastSavedMessageId,
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
    const collectedSources: NonNullable<AgentResult['sources']> = []
    let lastSavedMessageId: string | undefined

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
      } catch (err) {
        logger.warn('[Agent] Failed to save denial message', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      return {
        content: rejectionContent,
        toolExecutions: toolExecutionLog,
        sources: collectedSources.length ? collectedSources : undefined,
        lastMessageId: lastSavedMessageId,
      }
    }

    // Pre-load capabilities for resume execution
    const capabilities = await capabilityService.getEnabledCapabilitiesForWorkspace(workspaceId)
    const enabledCapabilitySlugs = new Set(capabilities.map((cap) => cap.slug))
    const storedConversationLoadedCapabilitySlugs = getSessionLoadedCapabilitySlugs(
      session.sessionAllowRules,
    )
    let conversationLoadedCapabilitySlugs = mergeConversationLoadedCapabilitySlugs(
      storedConversationLoadedCapabilitySlugs,
      state.mentionedSlugs,
      enabledCapabilitySlugs,
    )

    if (
      !stringArraysEqual(storedConversationLoadedCapabilitySlugs, conversationLoadedCapabilitySlugs)
    ) {
      await prisma.chatSession.update({
        where: { id: sessionId },
        data: {
          sessionAllowRules: buildSessionConversationState(session.sessionAllowRules, {
            loadedCapabilitySlugs: conversationLoadedCapabilitySlugs,
          }),
        },
      })
    }

    // Process approved tool calls — execute them with the shared dispatch infrastructure
    const resumeExecutionIds: string[] = []

    // LLM needed for multimodal handling
    const llm = await createLLMProvider()

    // Remove delegation-only tools from the main agent (must use delegate_task instead)
    const tools = capabilityService
      .buildToolDefinitions(capabilities)
      .filter((t) => !DELEGATION_ONLY_TOOLS.has(t.name))

    // Build dispatch context for the resume
    const dispatchCtx: ToolDispatchContext = {
      sessionId,
      workspaceId,
      inventory,
      emit,
      log,
      messages,
      toolExecutionLog,
      collectedSources,
      capabilities,
      tools,
      allowRules: [], // populated below
      autoApprove: false, // populated below
      sandboxReady: true, // sandbox was set up during initial runAgentLoop
      modelId: llm.modelId,
      mentionedSlugs: state.mentionedSlugs,
      signal,
      discoveredCapabilities: [],
      enabledCapabilitySlugs,
      conversationLoadedCapabilitySlugs,
    }

    // Execute approved pending tool calls using shared post-processing
    const resolvedPending = state.pendingToolCalls.map((toolCall) => {
      const publicToolArgs = secretRedactionService.redactForPublicStorage(
        toolCall.arguments,
        inventory,
      )
      const approval = approvals.find((a) => a.toolCallId === toolCall.id)
      const matchedCap = capabilities.find((cap) => {
        const defs = cap.toolDefinitions as Array<{ name: string }>
        return defs?.some((t) => t.name === toolCall.name)
      })
      const capabilitySlug = matchedCap?.slug ?? approval?.capabilitySlug ?? 'unknown'
      return { toolCall, publicToolArgs, matchedCap, capabilitySlug }
    })

    // Helper: execute a single approved tool and return its result
    const executeApprovedTool = (r: (typeof resolvedPending)[number]) => {
      const { toolCall, publicToolArgs, matchedCap, capabilitySlug } = r
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
        capability: matchedCap
          ? {
              slug: matchedCap.slug,
              skillType: (matchedCap as Record<string, unknown>).skillType as string | null,
              toolDefinitions: matchedCap.toolDefinitions,
            }
          : undefined,
        emit,
        capabilities,
        mentionedSlugs: state.mentionedSlugs,
        signal,
      })
    }

    // Helper: post-process an approved tool result (SSE, sources, messages)
    const postProcessApprovedTool = async (
      r: (typeof resolvedPending)[number],
      result: ExecutionResult,
    ) => {
      const { toolCall, capabilitySlug } = r
      log.logToolResult(toolCall.name, result)

      const isDiscoveryToolResume = toolCall.name === 'discover_tools'
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

      if (isDiscoveryToolResume && result.output) {
        try {
          const parsed = JSON.parse(result.output)
          if (parsed.type === 'discovery_result' && parsed.discovered?.length) {
            const newCaps: typeof parsed.discovered = []
            for (const cap of parsed.discovered) {
              if (dispatchCtx.discoveredCapabilities.some((dc) => dc.slug === cap.slug)) continue
              newCaps.push(cap)
              dispatchCtx.discoveredCapabilities.push({
                slug: cap.slug,
                name: cap.name,
                toolDefinitions: cap.tools,
                systemPrompt: cap.instructions,
                networkAccess: cap.networkAccess,
                skillType: cap.skillType,
              })
              for (const tool of cap.tools as import('../capabilities/types.js').ToolDefinition[]) {
                if (
                  !dispatchCtx.tools.some((t) => t.name === tool.name) &&
                  !DELEGATION_ONLY_TOOLS.has(tool.name)
                ) {
                  dispatchCtx.tools.push({
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
            dispatchCtx.conversationLoadedCapabilitySlugs =
              await persistConversationLoadedCapabilitySlugs(
                sessionId,
                dispatchCtx.conversationLoadedCapabilitySlugs,
                newCaps.map((cap: { slug: string }) => cap.slug),
                enabledCapabilitySlugs,
              )
            log.debugLog('Tools dynamically injected (resume)', {
              newSlugs: newCaps.map((c: { slug: string }) => c.slug),
              skippedDuplicates: parsed.discovered.length - newCaps.length,
              totalTools: dispatchCtx.tools.length,
            })
          }
        } catch (err) {
          logger.warn('[Agent] Discovery output parse failed (resume)', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      if (!result.error && capabilitySlug !== 'unknown') {
        dispatchCtx.conversationLoadedCapabilitySlugs =
          await persistConversationLoadedCapabilitySlugs(
            sessionId,
            dispatchCtx.conversationLoadedCapabilitySlugs,
            [capabilitySlug],
            enabledCapabilitySlugs,
          )
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

    // Save the approved tool calls as a ChatMessage
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
        logger.error('[Agent] Failed to save approved tools message', saveErr, { sessionId })
      }
    }

    // Clean up approvals
    await prisma.toolApproval.deleteMany({
      where: { chatSessionId: sessionId },
    })

    // Load auto-approve rules (workspace + session-scoped)
    const resumeSession = await prisma.chatSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { sessionAllowRules: true },
    })
    const resumeSessionRules = getSessionAllowRules(resumeSession.sessionAllowRules)
    const resumeWorkspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: state.workspaceId },
      select: { autoExecute: true, permissions: true },
    })
    dispatchCtx.allowRules = [
      ...(((resumeWorkspace.permissions as { allow?: string[] } | null)?.allow ?? []).filter(
        (rule): rule is string => typeof rule === 'string',
      ) as string[]),
      ...resumeSessionRules,
    ]
    dispatchCtx.autoApprove = resumeWorkspace.autoExecute

    // Continue the agent loop from where we left off
    const iterResult = await runIterationLoop({
      dispatchCtx,
      llm,
      log,
      emit,
      sessionId,
      inventory,
      startIteration: state.iteration,
      signal,
    })

    lastSavedMessageId = iterResult.lastSavedMessageId ?? lastSavedMessageId

    if (iterResult.paused) {
      return {
        paused: true,
        content: '',
        toolExecutions: toolExecutionLog,
        sources: collectedSources.length ? collectedSources : undefined,
        lastMessageId: lastSavedMessageId,
      }
    }

    await prisma.chatSession.update({
      where: { id: sessionId },
      data: { agentStatus: 'idle' },
    })

    return {
      content: iterResult.finalContent,
      toolExecutions: toolExecutionLog,
      sources: collectedSources.length ? collectedSources : undefined,
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

// ── Shared iteration loop ──

type IterationLoopParams = {
  dispatchCtx: ToolDispatchContext
  llm: LLMProvider
  log: SessionLogger
  emit?: SSEEmit
  sessionId: string
  inventory: SecretInventory
  startIteration: number
  signal?: AbortSignal
}

type IterationLoopResult = {
  paused: boolean
  pauseContent?: string
  accumulatedContent: string
  finalContent: string
  lastSavedMessageId?: string
}

async function runIterationLoop(params: IterationLoopParams): Promise<IterationLoopResult> {
  const { dispatchCtx, llm, log, emit, sessionId, inventory, startIteration, signal } = params
  const { messages, toolExecutionLog, collectedSources, tools } = dispatchCtx

  let accumulatedContent = ''
  let lastSavedMessageId: string | undefined

  const maxIterations = await settingsService.getMaxAgentIterations()
  for (let i = startIteration; i < maxIterations; i++) {
    if (signal?.aborted) {
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
    const response = await retryProviderTimeoutOnce(() => llm.chatWithTools(messages, { tools }), {
      onRetry: () => {
        log.debugLog('Retrying LLM request after provider timeout', {
          providerId: llm.providerId,
          modelId: llm.modelId,
          iteration: i + 1,
        })
        emit?.('thinking', { message: 'Model timed out, retrying once...' })
      },
    })
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
      logToolCallSizes(response.toolCalls, log)
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
      const finalContent = isDuplicate
        ? accumulatedContent.trim()
        : (accumulatedContent + safeResponseContent).trim()

      const fallbackContent = finalContent
        ? null
        : getEmptyFinalResponseFallback(toolExecutionLog.length > 0 || collectedSources.length > 0)

      if (isDuplicate) {
        log.debugLog('Skipping duplicate final content', {
          accumulatedLength: accumulatedContent.length,
          finalLength: safeResponseContent.length,
        })
      } else if (safeResponseContent.trim()) {
        emit?.('content', { text: safeResponseContent })
      } else if (fallbackContent) {
        log.debugLog('LLM returned empty final response; using fallback', {
          totalToolExecutions: toolExecutionLog.length,
          collectedSourceCount: collectedSources.length,
        })
        emit?.('content', { text: fallbackContent })
      }

      const resolvedFinalContent =
        finalContent ||
        getEmptyFinalResponseFallback(toolExecutionLog.length > 0 || collectedSources.length > 0)

      const contentToPersist = !isDuplicate ? safeResponseContent.trim() || fallbackContent : null

      // Save final assistant message to DB when we have either model output or a fallback.
      if (contentToPersist) {
        try {
          const finalMsg = await prisma.chatMessage.create({
            data: {
              sessionId,
              role: 'assistant',
              content: stripNullBytes(contentToPersist),
              ...(collectedSources.length && safeResponseContent.trim()
                ? { sources: collectedSources }
                : {}),
            },
          })
          lastSavedMessageId = finalMsg.id
          log.debugLog('Saved final message', { messageId: finalMsg.id })
        } catch (saveErr) {
          logger.error('[Agent] Failed to save final message', saveErr, { sessionId })
        }
      }

      return {
        paused: false,
        accumulatedContent,
        finalContent: resolvedFinalContent,
        lastSavedMessageId,
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

    // Execute tool calls using the shared dispatch infrastructure
    const { status, executionIds } = await executeToolCalls(dispatchCtx, response.toolCalls, i)

    if (status === 'paused') {
      return {
        paused: true,
        pauseContent: safeResponseContent.trim() || undefined,
        accumulatedContent,
        finalContent: '',
        lastSavedMessageId,
      }
    }

    // Per-iteration DB persistence
    const iterMsgId = await persistIterationMessage(
      dispatchCtx,
      safeResponseContent,
      response.toolCalls,
      executionIds,
    )
    if (iterMsgId) lastSavedMessageId = iterMsgId
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
  } catch (err) {
    logger.warn('[Agent] Failed to save max-iterations message', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return {
    paused: false,
    accumulatedContent: accumulatedContent + maxIterContent,
    finalContent: (accumulatedContent + maxIterContent).trim(),
    lastSavedMessageId,
  }
}
