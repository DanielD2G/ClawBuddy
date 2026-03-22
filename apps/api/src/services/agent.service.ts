import { Prisma } from '@prisma/client'
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'
import {
  Command,
  END,
  interrupt,
  isInterrupted,
  START,
  StateGraph,
  Annotation,
} from '@langchain/langgraph'
import { prisma } from '../lib/prisma.js'
import type {
  ChatMessage,
  LLMProvider,
  LLMToolDefinition,
  MessageContent,
  TokenUsage,
  ToolCall,
} from '../providers/llm.interface.js'
import {
  createExecuteLLM,
  createExploreLLM,
  createLLMProvider,
  createLightLLM,
  createMediumLLM,
} from '../providers/index.js'
import type { SSEEmit } from '../lib/sse.js'
import { capabilityService } from './capability.service.js'
import { NON_SANDBOX_TOOLS, toolExecutorService } from './tool-executor.service.js'
import { sandboxService } from './sandbox.service.js'
import { permissionService } from './permission.service.js'
import { compressContext } from './context-compression.service.js'
import { settingsService } from './settings.service.js'
import { DELEGATION_ONLY_TOOLS, MAX_AGENT_DOCUMENTS, TOOL_ARG_SIZE_LIMIT } from '../constants.js'
import { stripNullBytes } from '../lib/sanitize.js'
import type { SecretInventory } from './secret-redaction.service.js'
import { secretRedactionService } from './secret-redaction.service.js'
import { buildConversationMessages } from './agent-message-builder.js'
import { buildToolResultContent, maybeTruncateOutput } from './agent-tool-results.service.js'
import { buildPromptSection } from './system-prompt-builder.js'
import type { AgentResult } from './agent-state.service.js'
import { getLangGraphCheckpointer } from './langgraph-checkpointer.service.js'
import { SUB_AGENT_ROLES } from './sub-agent-roles.js'

const SIZE_GUARD_EXEMPT = new Set(['generate_file', 'save_document', 'search_documents'])

type MainGraphRole =
  | 'evaluate'
  | 'simple'
  | 'plan'
  | 'explore'
  | 'analyze'
  | 'execute'
  | 'buildResponse'

type ToolExecutionEntry = AgentResult['toolExecutions'][number]
type DocumentSource = NonNullable<AgentResult['sources']>[number]

interface ExecutionContext {
  workspaceId: string
  sessionId: string
  emit?: SSEEmit
  inventory: SecretInventory
  autoApprove: boolean
  allowRules: string[]
  capabilities: Array<{
    slug: string
    toolDefinitions: unknown
    skillType?: string | null
    name: string
    systemPrompt: string
    networkAccess?: boolean
  }>
  mentionedSlugs?: string[]
  signal?: AbortSignal
  llmByRole: Record<MainGraphRole, LLMProvider>
}

interface PlanResult {
  summary: string
  needsExplore: boolean
  exploreTask?: string
  needsAnalyze: boolean
  analyzeTask?: string
  needsExecute: boolean
  executeTask?: string
}

function getLangChainMessageText(message: {
  content: string | Array<{ type?: string; text?: string }>
}) {
  if (typeof message.content === 'string') return message.content
  return message.content
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

const AgentStateAnnotation = Annotation.Root({
  messages: Annotation<Array<AIMessage | HumanMessage | SystemMessage | ToolMessage>>({
    reducer: (left, right) => left.concat(Array.isArray(right) ? right : [right]),
    default: () => [],
  }),
  mode: Annotation<'simple' | 'plan' | null>(),
  plan: Annotation<PlanResult | null>(),
  phaseResults: Annotation<Record<string, string>>(),
  lastResponse: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
})

function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function parseJsonObject<T>(text: string): T | null {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1] ?? trimmed
  return safeJsonParse<T>(candidate)
}

function mapUsage(usage: TokenUsage | undefined) {
  return usage
}

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

function convertHistoryMessage(message: { role: string; content: string }) {
  switch (message.role) {
    case 'assistant':
      return new AIMessage(message.content)
    case 'tool':
      return new ToolMessage({ content: message.content, tool_call_id: 'history' })
    case 'system':
      return new SystemMessage(message.content)
    case 'user':
    default:
      return new HumanMessage(message.content)
  }
}

function getTextContent(content: MessageContent) {
  if (typeof content === 'string') return content
  return content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

function aiMessageToLegacyToolCall(toolCall: {
  id?: string
  name: string
  args?: Record<string, unknown>
}): ToolCall {
  return {
    id: toolCall.id ?? `${toolCall.name}_${Date.now()}`,
    name: toolCall.name,
    arguments: toolCall.args ?? {},
  }
}

function filterToolsForRole(
  allTools: LLMToolDefinition[],
  role: 'explore' | 'analyze' | 'execute',
) {
  const roleConfig = SUB_AGENT_ROLES[role]
  if (!roleConfig) return allTools

  if (roleConfig.allowedTools === 'all') {
    const denied = new Set(roleConfig.deniedTools ?? [])
    return allTools.filter((tool) => !denied.has(tool.name))
  }

  const allowed = new Set(roleConfig.allowedTools)
  return allTools.filter((tool) => allowed.has(tool.name))
}

async function buildBaseAgentContext(
  sessionId: string,
  userContent: string,
  workspaceId: string,
  inventory: SecretInventory,
  historyIncludesCurrentUserMessage?: boolean,
) {
  const capabilities = await capabilityService.getEnabledCapabilitiesForWorkspace(workspaceId)
  const timezone = await settingsService.getTimezone()
  const tools = capabilityService
    .buildToolDefinitions(capabilities)
    .filter((tool) => !DELEGATION_ONLY_TOOLS.has(tool.name))
  let systemPrompt = capabilityService.buildSystemPrompt(capabilities, timezone)

  const docs = await prisma.document.findMany({
    where: { workspaceId, status: 'READY' },
    select: { title: true, type: true },
    orderBy: { createdAt: 'desc' },
    take: MAX_AGENT_DOCUMENTS,
  })

  if (docs.length) {
    const manifest = docs.map((doc) => `- ${doc.title} (${doc.type})`).join('\n')
    systemPrompt += `\n\n${buildPromptSection(
      'workspace_documents',
      `The following ${docs.length} documents are available for search via search_documents:\n${manifest}`,
    )}`
  }

  const history = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  })

  const sessionData = await prisma.chatSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: {
      contextSummary: true,
      contextSummaryUpTo: true,
      lastInputTokens: true,
    },
  })

  const contextLimitTokens = await settingsService.getContextLimitTokens()
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
  }

  const messages = buildConversationMessages({
    systemPrompt,
    summary: compressed.summary,
    recentMessages: compressed.recentMessages.map((message) => ({
      role: message.role as ChatMessage['role'],
      content: message.content,
    })),
    currentUserContent: userContent,
    historyIncludesCurrentUserMessage,
  })

  return {
    capabilities,
    tools,
    systemPrompt,
    messages: messages.map((message) =>
      convertHistoryMessage({
        role: message.role,
        content: getTextContent(message.content),
      }),
    ),
  }
}

function resolveCapabilityForTool(
  toolName: string,
  capabilities: ExecutionContext['capabilities'],
) {
  const matched = capabilities.find((capability) => {
    const definitions = capability.toolDefinitions as Array<{ name: string }>
    return definitions?.some((definition) => definition.name === toolName)
  })

  return {
    capability: matched,
    capabilitySlug: matched?.slug ?? 'unknown',
  }
}

async function ensureSandboxIfNeeded(context: ExecutionContext, tools: LLMToolDefinition[]) {
  const needsSandbox = toolExecutorService.needsSandbox(tools.map((tool) => tool.name))
  if (!needsSandbox) return

  const needsNetwork = context.capabilities.some((capability) => capability.networkAccess)
  const needsDockerSocket = context.capabilities.some((capability) => capability.slug === 'docker')
  const configEnvVars = await capabilityService.getDecryptedCapabilityConfigsForWorkspace(
    context.workspaceId,
  )
  const mergedEnvVars: Record<string, string> = {}

  for (const envMap of configEnvVars.values()) {
    Object.assign(mergedEnvVars, envMap)
  }

  await sandboxService.getOrCreateWorkspaceContainer(
    context.workspaceId,
    { networkAccess: needsNetwork, dockerSocket: needsDockerSocket },
    Object.keys(mergedEnvVars).length ? mergedEnvVars : undefined,
  )
}

async function persistAssistantTurn(
  sessionId: string,
  content: string,
  toolEntries: Array<ToolExecutionEntry & { toolCallId: string }>,
  sources: DocumentSource[],
) {
  const blocks: Array<{ type: 'text'; text: string } | { type: 'tool'; toolIndex: number }> = []
  if (content.trim()) {
    blocks.push({ type: 'text', text: content })
  }

  for (let index = 0; index < toolEntries.length; index++) {
    blocks.push({ type: 'tool', toolIndex: index })
  }

  const toolCalls = toolEntries.map((entry) => ({
    name: entry.toolName,
    capability: entry.capabilitySlug,
    input: entry.input,
    output: entry.output,
    error: entry.error,
    exitCode: entry.exitCode,
    durationMs: entry.durationMs,
  }))

  const message = await prisma.chatMessage.create({
    data: {
      sessionId,
      role: 'assistant',
      content: stripNullBytes(content),
      ...(toolCalls.length ? { toolCalls: toolCalls as unknown as Prisma.InputJsonValue } : {}),
      ...(blocks.length ? { contentBlocks: blocks as unknown as Prisma.InputJsonValue } : {}),
      ...(sources.length ? { sources } : {}),
    },
  })

  return message.id
}

async function callRoleModel(
  context: ExecutionContext,
  role: MainGraphRole,
  messages: ChatMessage[],
  tools?: LLMToolDefinition[],
) {
  const llm = context.llmByRole[role]
  const response = await llm.chatWithTools(messages, { tools })
  await recordTokenUsage(mapUsage(response.usage), context.sessionId, llm.providerId, llm.modelId)
  return response
}

async function executeApprovedToolCall(
  context: ExecutionContext,
  toolCall: ToolCall,
  capabilitySlug: string,
  matchedCapability: ExecutionContext['capabilities'][number] | undefined,
) {
  const result = await toolExecutorService.execute(toolCall, capabilitySlug, {
    workspaceId: context.workspaceId,
    chatSessionId: context.sessionId,
    secretInventory: context.inventory,
    capability: matchedCapability
      ? {
          slug: matchedCapability.slug,
          skillType: matchedCapability.skillType ?? null,
          toolDefinitions: matchedCapability.toolDefinitions,
        }
      : undefined,
    emit: context.emit,
    capabilities: context.capabilities,
    mentionedSlugs: context.mentionedSlugs,
    signal: context.signal,
  })

  return result
}

async function maybeRequireApproval(
  context: ExecutionContext,
  toolCall: ToolCall,
  capabilitySlug: string,
  publicToolArgs: Record<string, unknown>,
) {
  const isAllowed = permissionService.isToolAllowed(toolCall, context.allowRules)
  if (isAllowed || context.autoApprove) return { approved: true as const }

  const approval = await prisma.toolApproval.create({
    data: {
      chatSessionId: context.sessionId,
      toolName: toolCall.name,
      capabilitySlug,
      input: publicToolArgs as Prisma.InputJsonValue,
      toolCallId: toolCall.id,
    },
  })

  context.emit?.('approval_required', {
    approvalId: approval.id,
    toolName: toolCall.name,
    capabilitySlug,
    input: publicToolArgs,
  })

  await prisma.chatSession.update({
    where: { id: context.sessionId },
    data: { agentStatus: 'awaiting_approval' },
  })

  const resume = interrupt<
    { approvalId: string; toolName: string },
    { decision: 'approved' | 'denied' }
  >({
    approvalId: approval.id,
    toolName: toolCall.name,
  })

  return { approved: resume?.decision !== 'denied' }
}

async function executeToolCalls(context: ExecutionContext, aiMessage: AIMessage) {
  const toolCalls = (aiMessage.tool_calls ?? []).map((toolCall) =>
    aiMessageToLegacyToolCall(
      toolCall as { id?: string; name: string; args?: Record<string, unknown> },
    ),
  )
  const toolMessages: ToolMessage[] = []
  const toolEntries: Array<ToolExecutionEntry & { toolCallId: string }> = []
  const collectedSources: DocumentSource[] = []

  for (const toolCall of toolCalls) {
    const publicToolArgs = secretRedactionService.redactForPublicStorage(
      toolCall.arguments,
      context.inventory,
    )
    const { capability, capabilitySlug } = resolveCapabilityForTool(
      toolCall.name,
      context.capabilities,
    )

    const sizeRejection = checkToolArgSize(toolCall)
    if (sizeRejection) {
      toolMessages.push(
        new ToolMessage({
          content: sizeRejection,
          tool_call_id: toolCall.id,
        }),
      )
      toolEntries.push({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        capabilitySlug,
        input: publicToolArgs,
        error: sizeRejection,
        durationMs: 0,
      })
      continue
    }

    const approval = await maybeRequireApproval(context, toolCall, capabilitySlug, publicToolArgs)
    if (!approval.approved) {
      const deniedMessage = `Error: Tool "${toolCall.name}" was not approved.`
      toolMessages.push(
        new ToolMessage({
          content: deniedMessage,
          tool_call_id: toolCall.id,
        }),
      )
      toolEntries.push({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        capabilitySlug,
        input: publicToolArgs,
        error: deniedMessage,
        durationMs: 0,
      })
      continue
    }

    context.emit?.('tool_start', {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      capabilitySlug,
      input: publicToolArgs,
    })

    const result = await executeApprovedToolCall(context, toolCall, capabilitySlug, capability)

    context.emit?.('tool_result', {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      output: result.output,
      error: result.error,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    })

    const rawContent =
      toolCall.name === 'run_browser_script'
        ? result.output
        : result.error
          ? `Error: ${result.error}\n\n${result.output}`
          : result.output

    const isSandboxTool = !NON_SANDBOX_TOOLS.has(toolCall.name)
    const toolContent =
      isSandboxTool && context.workspaceId
        ? await maybeTruncateOutput(rawContent, toolCall.id, context.workspaceId)
        : rawContent
    const messageContent: MessageContent =
      toolCall.name === 'run_browser_script'
        ? buildToolResultContent(toolContent, context.llmByRole.simple.modelId)
        : toolContent

    toolMessages.push(
      new ToolMessage({
        content:
          typeof messageContent === 'string' ? messageContent : getTextContent(messageContent),
        tool_call_id: toolCall.id,
      }),
    )

    toolEntries.push({
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      capabilitySlug,
      input: publicToolArgs,
      output: result.output || undefined,
      error: result.error,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      subAgentExecutionIds: result.subAgentExecutionIds,
    })

    if (result.sources?.length) {
      for (const source of result.sources) {
        if (!collectedSources.some((entry) => entry.documentId === source.documentId)) {
          collectedSources.push(source)
        }
      }
      context.emit?.('sources', { sources: collectedSources })
    }
  }

  return {
    toolMessages,
    toolEntries,
    collectedSources,
  }
}

async function runSimpleBranch(
  state: typeof AgentStateAnnotation.State,
  context: ExecutionContext,
  tools: LLMToolDefinition[],
) {
  await ensureSandboxIfNeeded(context, tools)

  let workingMessages = [...state.messages]
  let finalContent = ''
  const allToolEntries: Array<ToolExecutionEntry & { toolCallId: string }> = []
  const allSources: DocumentSource[] = []

  const maxIterations = await settingsService.getMaxAgentIterations()
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const response = await callRoleModel(
      context,
      'simple',
      workingMessages.map((message) => ({
        role:
          message instanceof SystemMessage
            ? 'system'
            : message instanceof HumanMessage
              ? 'user'
              : message instanceof ToolMessage
                ? 'tool'
                : 'assistant',
        content: getLangChainMessageText(message),
      })),
      tools,
    )

    const aiMessage = new AIMessage({
      content: response.content,
      tool_calls: response.toolCalls?.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.arguments,
        type: 'tool_call' as const,
      })),
    })

    if (!response.toolCalls?.length) {
      finalContent = response.content
      if (response.content.trim()) {
        context.emit?.('content', { text: response.content })
        await prisma.chatMessage.create({
          data: {
            sessionId: context.sessionId,
            role: 'assistant',
            content: stripNullBytes(response.content),
            ...(allSources.length ? { sources: allSources } : {}),
          },
        })
      }
      return {
        messages: [aiMessage],
        lastResponse: finalContent,
      }
    }

    const { toolMessages, toolEntries, collectedSources } = await executeToolCalls(
      context,
      aiMessage,
    )
    allToolEntries.push(...toolEntries)
    for (const source of collectedSources) {
      if (!allSources.some((entry) => entry.documentId === source.documentId)) {
        allSources.push(source)
      }
    }

    await persistAssistantTurn(context.sessionId, response.content, toolEntries, collectedSources)
    workingMessages = [...workingMessages, aiMessage, ...toolMessages]
  }

  const limitMessage =
    'I reached the maximum number of tool-calling iterations. Here is what I found so far based on the tool outputs above.'
  context.emit?.('content', { text: limitMessage })
  await prisma.chatMessage.create({
    data: {
      sessionId: context.sessionId,
      role: 'assistant',
      content: stripNullBytes(limitMessage),
    },
  })

  return {
    lastResponse: limitMessage,
  }
}

async function runPhaseBranch(
  context: ExecutionContext,
  role: 'explore' | 'analyze' | 'execute',
  task: string,
  priorResults: Record<string, string>,
  tools: LLMToolDefinition[],
) {
  const llmRole = role as MainGraphRole
  const systemPrompt = [
    `You are the ${role} phase of a LangGraph workflow.`,
    `Complete only the work for this phase and finish with a concise, high-signal summary.`,
    'If tools are needed, use them deliberately and stop once this phase is complete.',
    priorResults.explore ? `Previous explore output:\n${priorResults.explore}` : '',
    priorResults.analyze ? `Previous analyze output:\n${priorResults.analyze}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  let messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ]

  const maxIterations = await settingsService.getMaxAgentIterations()
  const allToolEntries: Array<ToolExecutionEntry & { toolCallId: string }> = []
  const allSources: DocumentSource[] = []

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const response = await callRoleModel(context, llmRole, messages, tools)

    if (!response.toolCalls?.length) {
      if (response.content.trim()) {
        await persistAssistantTurn(context.sessionId, response.content, allToolEntries, allSources)
      }
      return response.content
    }

    const aiMessage = new AIMessage({
      content: response.content,
      tool_calls: response.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.arguments,
        type: 'tool_call' as const,
      })),
    })

    const { toolMessages, toolEntries, collectedSources } = await executeToolCalls(
      context,
      aiMessage,
    )

    allToolEntries.push(...toolEntries)
    for (const source of collectedSources) {
      if (!allSources.some((entry) => entry.documentId === source.documentId)) {
        allSources.push(source)
      }
    }

    messages = [
      ...messages,
      {
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      },
      ...toolMessages.map((message) => ({
        role: 'tool' as const,
        content: getLangChainMessageText(message),
        toolCallId: message.tool_call_id,
      })),
    ]
  }

  return `${role} phase reached the maximum iteration limit before completion.`
}

function defaultPlan(): PlanResult {
  return {
    summary: 'Unable to build a structured plan. Falling back to a simple execution path.',
    needsExplore: false,
    needsAnalyze: false,
    needsExecute: true,
    executeTask: 'Complete the request directly using the available tools.',
  }
}

async function buildAgentGraph(
  context: ExecutionContext,
  tools: LLMToolDefinition[],
  userContent: string,
  sessionId: string,
) {
  const graph = new StateGraph(AgentStateAnnotation)
    .addNode('evaluate', async (state) => {
      const prompt = [
        'Decide if this request should follow the simple route or the plan route.',
        'Return strict JSON: {"mode":"simple"|"plan","reason":"..."}',
        'Choose "simple" only for direct requests that do not benefit from explicit explore/analyze/execute phases.',
        'Choose "plan" for multi-step, investigative, ambiguous, or execution-heavy tasks.',
      ].join('\n')

      const response = await callRoleModel(context, 'evaluate', [
        { role: 'system', content: prompt },
        {
          role: 'user',
          content: state.messages.length
            ? getLangChainMessageText(state.messages[state.messages.length - 1])
            : userContent,
        },
      ])
      const parsed = parseJsonObject<{ mode?: 'simple' | 'plan' }>(response.content)
      return {
        mode: parsed?.mode === 'plan' ? 'plan' : 'simple',
      }
    })
    .addNode('simple', async (state) => runSimpleBranch(state, context, tools))
    .addNode('plan', async (state) => {
      const response = await callRoleModel(context, 'plan', [
        {
          role: 'system',
          content: [
            'Create a structured execution plan for this request.',
            'Return strict JSON with this schema:',
            '{"summary":"...", "needsExplore":boolean, "exploreTask":"...", "needsAnalyze":boolean, "analyzeTask":"...", "needsExecute":boolean, "executeTask":"..."}',
            'Set task fields only when the matching phase is needed.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: state.messages.length
            ? getLangChainMessageText(state.messages[state.messages.length - 1])
            : userContent,
        },
      ])

      return {
        plan: parseJsonObject<PlanResult>(response.content) ?? defaultPlan(),
      }
    })
    .addNode('explore', async (state) => {
      if (!state.plan?.needsExplore || !state.plan.exploreTask) return {}
      const summary = await runPhaseBranch(
        context,
        'explore',
        state.plan.exploreTask,
        state.phaseResults ?? {},
        filterToolsForRole(tools, 'explore'),
      )
      return {
        phaseResults: { ...(state.phaseResults ?? {}), explore: summary },
      }
    })
    .addNode('analyze', async (state) => {
      if (!state.plan?.needsAnalyze || !state.plan.analyzeTask) return {}
      const summary = await runPhaseBranch(
        context,
        'analyze',
        state.plan.analyzeTask,
        state.phaseResults ?? {},
        filterToolsForRole(tools, 'analyze'),
      )
      return {
        phaseResults: { ...(state.phaseResults ?? {}), analyze: summary },
      }
    })
    .addNode('execute', async (state) => {
      if (!state.plan?.needsExecute || !state.plan.executeTask) return {}
      const summary = await runPhaseBranch(
        context,
        'execute',
        state.plan.executeTask,
        state.phaseResults ?? {},
        filterToolsForRole(tools, 'execute'),
      )
      return {
        phaseResults: { ...(state.phaseResults ?? {}), execute: summary },
      }
    })
    .addNode('build_response', async (state) => {
      if (state.mode === 'simple') {
        return {
          lastResponse: state.lastResponse,
        }
      }

      const planSummary = state.plan?.summary ?? ''
      const phaseResults = state.phaseResults ?? {}
      const response = await callRoleModel(context, 'buildResponse', [
        {
          role: 'system',
          content:
            'Build the final user-facing response from the completed LangGraph phases. Be concise, direct, and grounded in the phase outputs.',
        },
        {
          role: 'user',
          content: [
            `Original request:\n${userContent}`,
            planSummary ? `Plan summary:\n${planSummary}` : '',
            phaseResults.explore ? `Explore:\n${phaseResults.explore}` : '',
            phaseResults.analyze ? `Analyze:\n${phaseResults.analyze}` : '',
            phaseResults.execute ? `Execute:\n${phaseResults.execute}` : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ])

      if (response.content.trim()) {
        context.emit?.('content', { text: response.content })
        const message = await prisma.chatMessage.create({
          data: {
            sessionId,
            role: 'assistant',
            content: stripNullBytes(response.content),
          },
        })
        return {
          lastResponse: response.content,
          lastMessageId: message.id,
        }
      }

      return {
        lastResponse: '',
      }
    })
    .addEdge(START, 'evaluate')
    .addConditionalEdges('evaluate', (state) => (state.mode === 'plan' ? 'plan' : 'simple'))
    .addEdge('simple', 'build_response')
    .addEdge('plan', 'explore')
    .addEdge('explore', 'analyze')
    .addEdge('analyze', 'execute')
    .addEdge('execute', 'build_response')
    .addEdge('build_response', END)

  return graph.compile({
    checkpointer: await getLangGraphCheckpointer(),
  })
}

export const agentService = {
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

    const { capabilities, tools, messages } = await buildBaseAgentContext(
      sessionId,
      userContent,
      workspaceId,
      inventory,
      options?.historyIncludesCurrentUserMessage,
    )

    const globalSettings = await prisma.globalSettings.findUnique({ where: { id: 'singleton' } })
    const sessionSettings = await prisma.chatSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { sessionAllowRules: true },
    })

    const context: ExecutionContext = {
      workspaceId,
      sessionId,
      emit,
      inventory,
      autoApprove: options?.autoApprove ?? false,
      allowRules: [
        ...((globalSettings?.autoApproveRules as string[]) ?? []),
        ...((sessionSettings.sessionAllowRules as string[]) ?? []),
      ],
      capabilities,
      mentionedSlugs: options?.mentionedSlugs,
      signal: options?.signal,
      llmByRole: {
        evaluate: await createMediumLLM(),
        simple: await createLLMProvider(),
        plan: await createMediumLLM(),
        explore: await createExploreLLM(),
        analyze: await createLightLLM(),
        execute: await createExecuteLLM(),
        buildResponse: await createLLMProvider(),
      },
    }

    const compiled = await buildAgentGraph(context, tools, userContent, sessionId)

    const result = await compiled.invoke(
      {
        messages,
        phaseResults: {},
      },
      {
        configurable: {
          thread_id: sessionId,
        },
        signal: options?.signal,
      },
    )

    if (isInterrupted(result)) {
      const approvals = await prisma.toolApproval.findMany({
        where: { chatSessionId: sessionId, status: 'pending' },
        select: { id: true },
      })
      emit?.('awaiting_approval', { approvalIds: approvals.map((approval) => approval.id) })
      return {
        paused: true,
        content: '',
        toolExecutions: [],
      }
    }

    await prisma.chatSession.update({
      where: { id: sessionId },
      data: { agentStatus: 'idle', agentStateEncrypted: null },
    })

    return {
      content: result.lastResponse ?? '',
      toolExecutions: [],
      lastMessageId: (result as Record<string, unknown>).lastMessageId as string | undefined,
    }
  },

  async resumeAgentLoop(
    sessionId: string,
    emit?: SSEEmit,
    inventoryArg?: SecretInventory,
    signal?: AbortSignal,
  ): Promise<AgentResult> {
    const session = await prisma.chatSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: {
        workspaceId: true,
      },
    })

    const inventory =
      inventoryArg ?? (await secretRedactionService.buildSecretInventory(session.workspaceId!))
    const pendingApproval = await prisma.toolApproval.findFirst({
      where: { chatSessionId: sessionId, status: { in: ['approved', 'denied'] } },
      orderBy: { decidedAt: 'desc' },
    })

    if (!pendingApproval) {
      throw new Error('No decided approval found to resume the graph')
    }

    await prisma.toolApproval.deleteMany({
      where: { chatSessionId: sessionId },
    })

    const { capabilities, tools } = await buildBaseAgentContext(
      sessionId,
      '',
      session.workspaceId!,
      inventory,
      true,
    )

    const globalSettings = await prisma.globalSettings.findUnique({ where: { id: 'singleton' } })
    const sessionSettings = await prisma.chatSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { sessionAllowRules: true },
    })

    const context: ExecutionContext = {
      workspaceId: session.workspaceId!,
      sessionId,
      emit,
      inventory,
      autoApprove: false,
      allowRules: [
        ...((globalSettings?.autoApproveRules as string[]) ?? []),
        ...((sessionSettings.sessionAllowRules as string[]) ?? []),
      ],
      capabilities,
      signal,
      llmByRole: {
        evaluate: await createMediumLLM(),
        simple: await createLLMProvider(),
        plan: await createMediumLLM(),
        explore: await createExploreLLM(),
        analyze: await createLightLLM(),
        execute: await createExecuteLLM(),
        buildResponse: await createLLMProvider(),
      },
    }

    const compiled = await buildAgentGraph(context, tools, '', sessionId)

    const result = await compiled.invoke(
      new Command({ resume: { decision: pendingApproval.status } }),
      {
        configurable: {
          thread_id: sessionId,
        },
        signal,
      },
    )

    if (isInterrupted(result)) {
      const approvals = await prisma.toolApproval.findMany({
        where: { chatSessionId: sessionId, status: 'pending' },
        select: { id: true },
      })
      emit?.('awaiting_approval', { approvalIds: approvals.map((approval) => approval.id) })
      return {
        paused: true,
        content: '',
        toolExecutions: [],
      }
    }

    await prisma.chatSession.update({
      where: { id: sessionId },
      data: { agentStatus: 'idle', agentStateEncrypted: null },
    })

    return {
      content: (result as Record<string, unknown>).lastResponse as string,
      toolExecutions: [],
      lastMessageId: (result as Record<string, unknown>).lastMessageId as string | undefined,
    }
  },
}
