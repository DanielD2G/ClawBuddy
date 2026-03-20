import {
  createLLMProvider,
  createLightLLM,
  createExploreLLM,
  createExecuteLLM,
} from '../providers/index.js'
import type {
  ChatMessage,
  LLMToolDefinition,
  LLMProvider,
  TokenUsage,
} from '../providers/llm.interface.js'
import { capabilityService } from './capability.service.js'
import { settingsService } from './settings.service.js'
import { toolExecutorService } from './tool-executor.service.js'
import { secretRedactionService } from './secret-redaction.service.js'
import type { SecretInventory } from './secret-redaction.service.js'
import { recordTokenUsage, checkToolArgSize } from './agent.service.js'
import { SUB_AGENT_ROLES } from './sub-agent-roles.js'
import type {
  SubAgentModelTier,
  SubAgentRequest,
  SubAgentResult,
  SubAgentRoleConfig,
} from './sub-agent.types.js'
import type { SSEEvent } from '../lib/sse.js'
import { OUTPUT_TRUNCATE_THRESHOLD, PARALLEL_SAFE_TOOLS } from '../constants.js'

// ── Helpers ─────────────────────────────────────────────────

async function createLLMForTier(tier: SubAgentModelTier): Promise<LLMProvider> {
  switch (tier) {
    case 'explore':
      return createExploreLLM()
    case 'execute':
      return createExecuteLLM()
    case 'light':
      return createLightLLM()
    case 'primary':
      return createLLMProvider()
  }
}

export function filterTools(
  allTools: LLMToolDefinition[],
  roleConfig: SubAgentRoleConfig,
): LLMToolDefinition[] {
  if (roleConfig.allowedTools === 'all') {
    const denied = new Set(roleConfig.deniedTools ?? [])
    return allTools.filter((t) => !denied.has(t.name))
  }
  const allowed = new Set(roleConfig.allowedTools)
  return allTools.filter((t) => allowed.has(t.name))
}

function buildSubAgentSystemPrompt(
  role: string,
  task: string,
  context: string | undefined,
  capabilityPrompts: string,
  preferredTools?: string[],
): string {
  const parts = [
    `You are a focused sub-agent with the role "${role}". Complete the task below and return a clear, concise summary of your findings or actions.`,
    '',
    '## Task',
    task,
  ]

  if (context) {
    parts.push('', '## Context from parent agent', context)
  }

  if (capabilityPrompts) {
    parts.push('', '## Available tool instructions', capabilityPrompts)
  }

  parts.push(
    '',
    '## Guidelines',
    '- Stay focused on the task. Do not deviate.',
    '- **Batch independent tool calls in a single response.** If you need multiple searches, fetches, or reads that do not depend on each other, call them all at once. This runs them concurrently.',
    '- When done, provide a structured summary of what you found or accomplished.',
    '- If a tool fails, report the error and move on. Do not retry indefinitely.',
  )

  if (preferredTools?.length) {
    parts.push(
      '',
      '## Required tools',
      `The user explicitly requested the following tools: ${preferredTools.join(', ')}.`,
      'You MUST use these tools to complete the task. Do NOT substitute with alternative tools (e.g. do not use web_search when run_browser_script was requested) unless the required tool fails.',
    )
  }

  return parts.join('\n')
}

// ── Sub-Agent Service ───────────────────────────────────────

type SubAgentEmit = (event: SSEEvent['event'], data: Record<string, unknown>) => void

export interface SubAgentContext {
  workspaceId: string
  sessionId: string
  linuxUser: string
  secretInventory: SecretInventory
  emit?: SubAgentEmit
  subAgentId?: string
  /** Pre-loaded capabilities from parent agent (avoids redundant DB query) */
  capabilities?: Array<{
    slug: string
    toolDefinitions: unknown
    skillType?: string | null
    name: string
    systemPrompt: string
  }>
  /** Isolated browser session key for this sub-agent (avoids page collisions in parallel execution) */
  browserSessionId?: string
  /** Tool names the user explicitly requested — sub-agent should prefer these over alternatives */
  preferredTools?: string[]
  /** Abort signal to cancel the sub-agent loop */
  signal?: AbortSignal
}

export const subAgentService = {
  async runSubAgent(
    request: SubAgentRequest,
    parentContext: SubAgentContext,
  ): Promise<SubAgentResult> {
    const roleConfig = SUB_AGENT_ROLES[request.role]
    if (!roleConfig) {
      return {
        role: request.role,
        success: false,
        result: `Unknown sub-agent role: ${request.role}`,
        toolExecutions: [],
        iterationsUsed: 0,
      }
    }

    // Read configured iteration limits from settings (overrides defaults)
    const maxIterations = await {
      explore: () => settingsService.getSubAgentExploreMaxIterations(),
      analyze: () => settingsService.getSubAgentAnalyzeMaxIterations(),
      execute: () => settingsService.getSubAgentExecuteMaxIterations(),
    }[request.role]()

    const { emit } = parentContext
    emit?.('sub_agent_start', {
      subAgentId: parentContext.subAgentId ?? request.task,
      role: request.role,
      task: request.task,
    })

    // Resolve LLM for this role's model tier
    const llm = await createLLMForTier(roleConfig.modelTier)

    // Use pre-loaded capabilities or fetch from DB
    const capabilities =
      parentContext.capabilities ??
      (await capabilityService.getEnabledCapabilitiesForWorkspace(parentContext.workspaceId))
    const allTools = capabilityService.buildToolDefinitions(capabilities)
    const tools = filterTools(allTools, roleConfig)

    if (!tools.length) {
      const result = 'No tools available for this sub-agent role in the current workspace.'
      emit?.('sub_agent_done', {
        subAgentId: parentContext.subAgentId ?? request.task,
        role: request.role,
        summary: result,
      })
      return {
        role: request.role,
        success: false,
        result,
        toolExecutions: [],
        iterationsUsed: 0,
      }
    }

    // Build capability prompts for allowed tools
    const allowedToolNames = new Set(tools.map((t) => t.name))
    const relevantCapabilities = capabilities.filter((cap: { toolDefinitions: unknown }) => {
      const defs = cap.toolDefinitions as Array<{ name: string }>
      return defs?.some((t) => allowedToolNames.has(t.name))
    })
    const capabilityPrompts = relevantCapabilities
      .map((c: { name: string; systemPrompt: string }) => `### ${c.name}\n${c.systemPrompt}`)
      .join('\n\n')

    const systemPrompt = buildSubAgentSystemPrompt(
      request.role,
      request.task,
      request.context,
      capabilityPrompts,
      parentContext.preferredTools,
    )

    // Fresh context — no history, just system + task
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: request.task },
    ]

    const toolExecutionLog: SubAgentResult['toolExecutions'] = []
    const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    let finalContent = ''

    // ── Simplified agent loop ──
    for (let i = 0; i < maxIterations; i++) {
      if (parentContext.signal?.aborted) {
        break
      }

      emit?.('thinking', {
        message: `Sub-agent (${request.role}) thinking...`,
        subAgent: request.role,
      })

      const response = await llm.chatWithTools(messages, { tools })

      // Track token usage
      if (response.usage) {
        totalUsage.inputTokens += response.usage.inputTokens
        totalUsage.outputTokens += response.usage.outputTokens
        totalUsage.totalTokens += response.usage.totalTokens
      }
      await recordTokenUsage(response.usage, parentContext.sessionId, llm.providerId, llm.modelId)

      // No tool calls — done
      if (response.finishReason === 'stop' || !response.toolCalls?.length) {
        finalContent = response.content || ''
        emit?.('sub_agent_done', {
          subAgentId: parentContext.subAgentId ?? request.task,
          role: request.role,
          summary: finalContent.slice(0, 500),
        })
        return {
          role: request.role,
          success: true,
          result: finalContent,
          toolExecutions: toolExecutionLog,
          iterationsUsed: i + 1,
          tokenUsage: totalUsage,
        }
      }

      // Add assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: response.content || '',
        toolCalls: response.toolCalls,
      })

      // Execute tool calls sequentially (sub-agents keep it simple)
      // Parallel-safe tools still run concurrently for efficiency
      const parallelBatch = response.toolCalls.filter((tc) => PARALLEL_SAFE_TOOLS.has(tc.name))
      const sequentialBatch = response.toolCalls.filter((tc) => !PARALLEL_SAFE_TOOLS.has(tc.name))

      const executeBatch = async (batch: typeof response.toolCalls, parallel: boolean) => {
        if (!batch.length) return

        const results =
          parallel && batch.length > 1
            ? await Promise.all(
                batch.map((tc) =>
                  subAgentService.executeSubAgentTool(
                    tc,
                    capabilities,
                    parentContext,
                    roleConfig,
                    emit,
                  ),
                ),
              )
            : []

        for (let idx = 0; idx < batch.length; idx++) {
          const tc = batch[idx]
          const { result, capabilitySlug, publicInput } =
            parallel && batch.length > 1
              ? results[idx]
              : await subAgentService.executeSubAgentTool(
                  tc,
                  capabilities,
                  parentContext,
                  roleConfig,
                  emit,
                )

          toolExecutionLog.push({
            toolName: tc.name,
            capabilitySlug,
            input: publicInput,
            output: result.output || undefined,
            error: result.error,
            durationMs: result.durationMs,
          })

          const toolContent = result.error
            ? `Error: ${result.error}\n\n${result.output}`
            : result.output

          messages.push({ role: 'tool', toolCallId: tc.id, content: toolContent })
        }
      }

      await executeBatch(parallelBatch, true)
      await executeBatch(sequentialBatch, false)
    }

    // Exhausted iterations
    finalContent = `Sub-agent (${request.role}) reached maximum iterations (${maxIterations}) without completing.`
    emit?.('sub_agent_done', {
      subAgentId: parentContext.subAgentId ?? request.task,
      role: request.role,
      summary: finalContent,
    })

    return {
      role: request.role,
      success: false,
      result: finalContent,
      toolExecutions: toolExecutionLog,
      iterationsUsed: maxIterations,
      tokenUsage: totalUsage,
    }
  },

  /** Execute a single tool call within the sub-agent context */
  async executeSubAgentTool(
    toolCall: { id: string; name: string; arguments: Record<string, unknown> },
    capabilities: Array<{ slug: string; toolDefinitions: unknown; skillType?: string | null }>,
    parentContext: SubAgentContext,
    roleConfig: SubAgentRoleConfig,
    emit?: SubAgentEmit,
  ) {
    const matched = capabilities.find((cap) => {
      const defs = cap.toolDefinitions as Array<{ name: string }>
      return defs?.some((t) => t.name === toolCall.name)
    })
    const capabilitySlug = matched?.slug ?? 'unknown'

    const publicInput = secretRedactionService.redactForPublicStorage(
      toolCall.arguments,
      parentContext.secretInventory,
    )

    // Size guard — reuse shared check from agent service
    const sizeRejection = checkToolArgSize(toolCall)
    if (sizeRejection) {
      emit?.('tool_result', {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        error: sizeRejection,
        durationMs: 0,
        subAgent: roleConfig.role,
        subAgentId: parentContext.subAgentId,
      })
      return {
        result: { output: '', error: sizeRejection, durationMs: 0 },
        capabilitySlug,
        publicInput,
      }
    }

    emit?.('tool_start', {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      capabilitySlug,
      input: publicInput,
      subAgent: roleConfig.role,
      subAgentId: parentContext.subAgentId,
    })

    const result = await toolExecutorService.execute(toolCall, capabilitySlug, {
      workspaceId: parentContext.workspaceId,
      chatSessionId: parentContext.sessionId,
      linuxUser: parentContext.linuxUser,
      secretInventory: parentContext.secretInventory,
      browserSessionId: parentContext.browserSessionId,
      capability: matched
        ? {
            slug: matched.slug,
            skillType: (matched as Record<string, unknown>).skillType as string | null,
            toolDefinitions: matched.toolDefinitions,
          }
        : undefined,
    })

    // Truncate large outputs inline (no sandbox file save in sub-agent context)
    if (result.output && result.output.length > OUTPUT_TRUNCATE_THRESHOLD) {
      const headSize = Math.floor(OUTPUT_TRUNCATE_THRESHOLD * 0.6)
      const tailSize = OUTPUT_TRUNCATE_THRESHOLD - headSize
      result.output =
        result.output.slice(0, headSize) +
        `\n\n... [TRUNCATED — ${result.output.length - headSize - tailSize} chars omitted] ...\n\n` +
        result.output.slice(-tailSize)
    }

    emit?.('tool_result', {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      output: result.output?.slice(0, 2000),
      error: result.error,
      durationMs: result.durationMs,
      subAgent: roleConfig.role,
      subAgentId: parentContext.subAgentId,
    })

    return { result, capabilitySlug, publicInput }
  },
}
