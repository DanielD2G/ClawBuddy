import { prisma } from '../lib/prisma.js'
import { Prisma } from '@prisma/client'
import { createLLMProvider } from '../providers/index.js'
import type { ChatMessage, ToolCall, TokenUsage, MessageContent, ContentBlock, LLMToolDefinition, LLMResponse } from '../providers/llm.interface.js'
import { getTextContent } from '../providers/llm.interface.js'
import type { SSEEmit } from '../lib/sse.js'
import { capabilityService } from './capability.service.js'
import { toolExecutorService, NON_SANDBOX_TOOLS } from './tool-executor.service.js'
import { sandboxService } from './sandbox.service.js'
import { permissionService } from './permission.service.js'
import { compressContext } from './context-compression.service.js'
import { settingsService } from './settings.service.js'
import {
  DEFAULT_MAX_AGENT_ITERATIONS,
  OUTPUT_TRUNCATE_THRESHOLD,
  TOOL_ARG_SIZE_LIMIT,
  MAX_SCREENSHOT_SSE_SIZE,
  LARGE_TOOL_ARG_THRESHOLD,
  MAX_AGENT_DOCUMENTS,
  TOOL_DISCOVERY_THRESHOLD,
  TOOL_DISCOVERY_MAX_CALLS,
  TOOL_RESULT_PROTECTION_WINDOW,
  MIN_PRUNE_SIZE,
  TOKEN_ESTIMATION_DIVISOR,
  PARALLEL_SAFE_TOOLS,
} from '../constants.js'
import { toolDiscoveryService } from './tool-discovery.service.js'
import type { ToolDefinition } from '../capabilities/types.js'

/** Tools exempt from the argument size guard (they have proper alternatives like sourcePath) */
const SIZE_GUARD_EXEMPT = new Set(['generate_file', 'save_document', 'search_documents'])

/** Models known to support vision/multimodal input */
const VISION_MODELS = new Set([
  'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-sonnet-4-20250514', 'claude-opus-4-0-20250514',
  'claude-sonnet-4-5-20250929', 'claude-opus-4-5-20251101', 'claude-haiku-4-5-20251001',
  'gpt-5.4', 'gpt-5.4-pro', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo',
  'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
  'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro',
  'gemini-3-flash-preview', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite-preview',
])

/**
 * Build a multimodal tool result message if the output contains a base64 screenshot.
 * Returns ContentBlock[] if screenshot found and model supports vision, otherwise returns the text string.
 */
function buildToolResultContent(output: string, modelId: string): MessageContent {
  // Check if the output looks like it contains a screenshot JSON result
  try {
    const parsed = JSON.parse(output)
    let screenshotB64: string | null = null

    if (parsed?.screenshot && typeof parsed.screenshot === 'string') {
      screenshotB64 = parsed.screenshot
    } else if (parsed?.screenshot?.type === 'Buffer' && Array.isArray(parsed.screenshot.data)) {
      screenshotB64 = Buffer.from(parsed.screenshot.data).toString('base64')
    }

    if (screenshotB64) {
      if (VISION_MODELS.has(modelId)) {
        const blocks: ContentBlock[] = []
        const description = parsed.description || parsed.content
        if (description) {
          blocks.push({ type: 'text', text: String(description) })
        }
        blocks.push({
          type: 'image',
          source: { type: 'base64', mediaType: 'image/jpeg', data: screenshotB64 },
        })
        return blocks
      }
      // Model doesn't support vision — return text only
      return parsed.description ?? 'Screenshot captured but the current model does not support vision.'
    }
  } catch {
    // Not JSON, return as-is
  }
  return output
}

/**
 * Check if a tool call's arguments exceed the size limit.
 * Returns a rejection message if too large, null otherwise.
 */
function checkToolArgSize(toolCall: { name: string; arguments: Record<string, unknown> }): string | null {
  if (SIZE_GUARD_EXEMPT.has(toolCall.name)) return null
  const commandArg = toolCall.arguments?.command ?? toolCall.arguments?.code ?? toolCall.arguments?.content
  if (typeof commandArg !== 'string' || commandArg.length <= TOOL_ARG_SIZE_LIMIT) return null

  const sizeKB = Math.round(commandArg.length / 1000)
  return `[BLOCKED] Your ${toolCall.name} call contains ${sizeKB}KB of inline data (limit: 5KB). ` +
    `Do NOT embed large data in commands. Instead:\n` +
    `1. The data is already saved in /workspace/.outputs/ from the previous tool output\n` +
    `2. Write a script that reads from that file path (e.g. cat /workspace/.outputs/file.txt | jq ...)\n` +
    `3. For generate_file, use the sourcePath parameter to reference the sandbox file\n\n` +
    `This command was NOT executed. Rewrite it to reference files instead of embedding data.`
}

/**
 * If output exceeds threshold, save it to a file in the sandbox and return a truncated version.
 */
async function maybeTruncateOutput(
  output: string,
  toolCallId: string,
  workspaceId: string,
  linuxUser: string,
): Promise<string> {
  if (output.length <= OUTPUT_TRUNCATE_THRESHOLD) return output

  const filename = `/workspace/.outputs/${toolCallId}.txt`
  try {
    // Write the full output to a file in the sandbox using base64 to avoid quoting issues
    const b64 = Buffer.from(output).toString('base64')
    await sandboxService.execInWorkspace(
      workspaceId,
      `echo '${b64}' | base64 -d > ${filename}`,
      linuxUser,
      { timeout: 10 },
    )
  } catch {
    // If we can't write the file, return the full output
    return output
  }

  const preview = output.slice(0, OUTPUT_TRUNCATE_THRESHOLD)
  return `${preview}\n\n⚠️ OUTPUT TRUNCATED (${output.length} chars) — full result saved to ${filename}\nIMPORTANT: Do NOT re-run this command. Use \`cat ${filename}\` or pipe through jq/grep/awk to process the saved file.\nDo NOT embed or echo the data — reference the file path directly.`
}

/** Max base64 size for screenshots sent via SSE (~500KB base64 ≈ ~375KB image) */

/**
 * Prepare tool result for SSE emission — strips large base64 screenshots
 * from the output field and sends them as a separate `screenshot` field.
 */
function prepareToolResultForSSE(
  toolName: string,
  result: { output?: string },
): { output?: string; screenshot?: string } {
  if (toolName !== 'run_browser_script' || !result.output) {
    return { output: result.output }
  }

  try {
    const parsed = JSON.parse(result.output)
    let b64: string | null = null

    if (parsed?.screenshot && typeof parsed.screenshot === 'string') {
      b64 = parsed.screenshot
    } else if (parsed?.screenshot?.type === 'Buffer' && Array.isArray(parsed.screenshot.data)) {
      // Handle Buffer-serialized screenshots (fallback)
      b64 = Buffer.from(parsed.screenshot.data).toString('base64')
    }

    if (b64) {
      // If image is too large, skip sending it via SSE to prevent crashes
      if (b64.length > MAX_SCREENSHOT_SSE_SIZE) {
        return { output: parsed.description || parsed.content || 'Screenshot captured (too large to display)' }
      }
      const description = parsed.description || parsed.content || 'Screenshot captured'
      return {
        output: typeof description === 'string' ? description : 'Screenshot captured',
        screenshot: `data:image/jpeg;base64,${b64}`,
      }
    }
  } catch { /* not JSON, return as-is */ }

  return { output: result.output }
}

/**
 * Prune old tool results from the messages array to reduce context size.
 * Protects the most recent tool outputs (within TOOL_RESULT_PROTECTION_WINDOW tokens)
 * and replaces older ones with placeholders.
 */
function pruneOldToolResults(messages: ChatMessage[], iteration: number): number {
  if (iteration < 3) return 0

  let recentToolTokens = 0
  let pruned = 0
  let foundBoundary = false

  // Walk backward to find the protection boundary
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'tool') continue
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    const tokens = Math.ceil(content.length / TOKEN_ESTIMATION_DIVISOR)

    if (!foundBoundary) {
      recentToolTokens += tokens
      if (recentToolTokens > TOOL_RESULT_PROTECTION_WINDOW) {
        foundBoundary = true
      }
      continue
    }

    // Beyond protection window — prune if large enough
    if (content.length <= MIN_PRUNE_SIZE) continue
    ;(msg as { content: string }).content =
      `[Tool result cleared — was ${content.length} chars. Re-run the tool if needed.]`
    pruned++
  }

  return pruned
}

export async function recordTokenUsage(
  usage: TokenUsage | undefined,
  sessionId: string,
  provider: string,
  model: string,
) {
  if (!usage) return
  try {
    const date = new Date().toISOString().slice(0, 10)
    await Promise.all([
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
      prisma.chatSession.update({
        where: { id: sessionId },
        data: { lastInputTokens: usage.inputTokens },
      }),
    ])
  } catch (err) {
    console.error('[Agent] Failed to record token usage:', err)
  }
}

const DEBUG = process.env.DEBUG_AGENT === '1' || process.env.DEBUG === '1'

// ── Session-scoped debug file logger ────────────────────────────
import { mkdirSync, appendFileSync } from 'fs'
import { join } from 'path'

const DEBUG_LOG_DIR = join(process.cwd(), 'logs', 'agent')

/** Ensure the logs directory exists (created once at startup) */
let logDirReady = false
function ensureLogDir() {
  if (logDirReady) return
  try {
    mkdirSync(DEBUG_LOG_DIR, { recursive: true })
    logDirReady = true
  } catch {
    // ignore — logging is best-effort
  }
}

/** Active session log file path (set per runAgentLoop / resumeAgentLoop call) */
let activeSessionLogFile: string | null = null

function debugLog(label: string, data?: unknown) {
  if (!DEBUG) return
  const ts = new Date().toISOString().slice(11, 23)
  const dataStr = data !== undefined
    ? (typeof data === 'string' ? data : JSON.stringify(data, null, 2))
    : ''
  const line = dataStr ? `[Agent ${ts}] ${label} ${dataStr}` : `[Agent ${ts}] ${label}`

  console.debug(line)

  // Also write to per-session log file
  if (activeSessionLogFile) {
    try {
      appendFileSync(activeSessionLogFile, line + '\n')
    } catch {
      // ignore write errors — logging is best-effort
    }
  }
}

/**
 * Initialize session log file. Creates a file named by sessionId + timestamp.
 * Returns the file path for reference.
 */
function initSessionLog(sessionId: string): void {
  if (!DEBUG) return
  ensureLogDir()
  const dateStr = new Date().toISOString().slice(0, 10)
  activeSessionLogFile = join(DEBUG_LOG_DIR, `${dateStr}_${sessionId}.log`)
  debugLog('═══ Session log initialized ═══')
}

/**
 * Log the full LLM request (messages + tools) to the session log file.
 */
function logLLMRequest(messages: ChatMessage[], tools: LLMToolDefinition[], iteration: number): void {
  if (!DEBUG || !activeSessionLogFile) return
  const separator = `\n${'─'.repeat(80)}\n`
  const lines = [
    separator,
    `>>> LLM REQUEST (iteration ${iteration})`,
    `>>> ${messages.length} messages, ${tools.length} tools`,
    separator,
    '>>> SYSTEM PROMPT:',
    getTextContent(messages[0]?.content ?? '').slice(0, 5000),
    separator,
    '>>> TOOLS:',
    tools.map((t) => `  - ${t.name}: ${t.description.slice(0, 120)}`).join('\n'),
    separator,
    '>>> MESSAGES (last 5):',
    ...messages.slice(-5).map((m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      const preview = content.slice(0, 1000)
      const toolCallsSummary = m.toolCalls?.map((tc) => `    [tool_call: ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 200)})]`).join('\n') ?? ''
      return `  [${m.role}${m.toolCallId ? ` toolCallId=${m.toolCallId}` : ''}] ${preview}${content.length > 1000 ? `... (${content.length} chars)` : ''}${toolCallsSummary ? '\n' + toolCallsSummary : ''}`
    }),
    separator,
  ]
  try {
    appendFileSync(activeSessionLogFile, lines.join('\n') + '\n')
  } catch { /* ignore */ }
}

/**
 * Log the full LLM response to the session log file.
 */
function logLLMResponse(response: LLMResponse, durationMs: number, iteration: number): void {
  if (!DEBUG || !activeSessionLogFile) return
  const separator = `\n${'─'.repeat(80)}\n`
  const lines = [
    separator,
    `<<< LLM RESPONSE (iteration ${iteration}, ${durationMs}ms)`,
    `<<< finishReason: ${response.finishReason}`,
    `<<< usage: ${response.usage ? `in=${response.usage.inputTokens} out=${response.usage.outputTokens} total=${response.usage.totalTokens}` : 'n/a'}`,
    separator,
    '<<< CONTENT:',
    response.content || '(empty)',
    ...(response.toolCalls?.length ? [
      separator,
      '<<< TOOL CALLS:',
      ...response.toolCalls.map((tc) =>
        `  - ${tc.name}(${JSON.stringify(tc.arguments, null, 2)})`
      ),
    ] : []),
    separator,
  ]
  try {
    appendFileSync(activeSessionLogFile, lines.join('\n') + '\n')
  } catch { /* ignore */ }
}

/**
 * Log a tool execution result to the session log file.
 */
function logToolResult(toolName: string, result: { output?: string; error?: string; exitCode?: number; durationMs: number }): void {
  if (!DEBUG || !activeSessionLogFile) return
  const lines = [
    `  ┌── TOOL RESULT: ${toolName} (${result.durationMs}ms, exit=${result.exitCode ?? 'n/a'})`,
    result.error ? `  │ ERROR: ${result.error}` : '',
    `  │ OUTPUT (${(result.output?.length ?? 0)} chars):`,
    `  │ ${(result.output ?? '').slice(0, 2000)}${(result.output?.length ?? 0) > 2000 ? `\n  │ ... (truncated)` : ''}`,
    `  └──`,
  ].filter(Boolean)
  try {
    appendFileSync(activeSessionLogFile, lines.join('\n') + '\n')
  } catch { /* ignore */ }
}

interface AgentResult {
  content: string
  toolExecutions: Array<{
    toolName: string
    capabilitySlug: string
    input: Record<string, unknown>
    output?: string
    error?: string
    exitCode?: number
    durationMs: number
  }>
  sources?: Array<{ documentId: string; documentTitle: string; chunkId: string; chunkIndex: number }>
  messageId?: string
}

interface AgentState {
  messages: ChatMessage[]
  iteration: number
  pendingToolCalls: ToolCall[]
  completedToolResults: Array<{ toolCallId: string; content: string }>
  linuxUser?: string
  toolExecutionLog: AgentResult['toolExecutions']
  workspaceId: string
  sessionId: string
  /** Slugs of capabilities discovered via tool discovery (for resume) */
  discoveredCapabilitySlugs?: string[]
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
    options?: { autoApprove?: boolean; mentionedSlugs?: string[] },
  ): Promise<AgentResult> {
    initSessionLog(sessionId)
    debugLog('runAgentLoop START', { sessionId, workspaceId, userContent: userContent.slice(0, 200) })
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
    let discoveryCallCount = 0

    if (useDiscovery) {
      const ctx = toolDiscoveryService.buildDiscoveryContext(capabilities, options?.mentionedSlugs)
      tools = ctx.tools
      systemPrompt = ctx.systemPrompt
      debugLog('Discovery mode ACTIVE', {
        capabilityCount: capabilities.length,
        loadedTools: tools.map((t) => t.name),
        alwaysOnSlugs: ctx.alwaysOnSlugs,
      })
    } else {
      tools = capabilityService.buildToolDefinitions(capabilities)
      systemPrompt = capabilityService.buildSystemPrompt(capabilities)
    }

    // Inject document manifest so the model knows what's searchable
    const docs = await prisma.document.findMany({
      where: { workspaceId, status: 'READY' },
      select: { title: true, type: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_AGENT_DOCUMENTS,
    })
    if (docs.length) {
      const manifest = docs.map(d => `- ${d.title} (${d.type})`).join('\n')
      systemPrompt += `\n\n# Workspace Documents\n\nThe following ${docs.length} documents are available for search via search_documents:\n${manifest}`
    }

    // Inject mandatory instruction when user explicitly mentioned capabilities
    if (options?.mentionedSlugs?.length) {
      const mentionedNames = options.mentionedSlugs
        .map((slug) => capabilities.find((c) => c.slug === slug)?.name ?? slug)
        .filter(Boolean)
      if (mentionedNames.length) {
        systemPrompt += `\n\n## Explicitly Requested Tools\nThe user explicitly requested the following capabilities: ${mentionedNames.join(', ')}.\nYou MUST use the tools from these capabilities to fulfill this request. Do NOT substitute with other tools unless the requested tool fails or is clearly not applicable.`
      }
    }

    debugLog('Capabilities loaded', {
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

    debugLog('History loaded', { messageCount: history.length })

    // Context compression — summarize older messages if context is too large
    const sessionData = await prisma.chatSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { contextSummary: true, contextSummaryUpTo: true, lastInputTokens: true, sessionAllowRules: true },
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
      emit?.('compressing', { status: 'done', summarizedCount, keptCount: compressed.recentMessages.length })
      debugLog('Context compressed', { summarizedCount, keptCount: compressed.recentMessages.length })
    } else {
      emit?.('compressing', { status: 'skipped' })
    }

    // Build message list, merging consecutive messages with the same role
    // (Gemini rejects consecutive user messages from e.g. failed cron runs)
    const rawMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...(compressed.summary
        ? [
            { role: 'user' as const, content: `[Previous conversation summary]\n${compressed.summary}` },
            { role: 'assistant' as const, content: 'Understood, I have context from our earlier conversation.' },
          ]
        : []),
      ...compressed.recentMessages.map((m) => ({
        role: m.role as ChatMessage['role'],
        content: m.content,
      })),
      { role: 'user', content: userContent },
    ]
    const messages: ChatMessage[] = []
    for (const msg of rawMessages) {
      const prev = messages[messages.length - 1]
      if (prev && prev.role === msg.role && msg.role === 'user') {
        ;(prev as { content: string }).content += '\n\n' + msg.content
      } else {
        messages.push({ ...msg })
      }
    }

    debugLog('Messages prepared', {
      totalMessages: messages.length,
      systemPromptLength: systemPrompt.length,
    })

    const toolExecutionLog: AgentResult['toolExecutions'] = []
    const collectedSources: NonNullable<AgentResult['sources']> = []
    let accumulatedContent = ''

    // Determine if we need a sandbox
    // In discovery mode, always start sandbox since discovered tools may need it
    const allToolNames = tools.map((t) => t.name)
    const needsSandbox = useDiscovery || toolExecutorService.needsSandbox(allToolNames)

    debugLog('Sandbox check', { needsSandbox, allToolNames })

    let linuxUser: string | undefined

    if (needsSandbox) {
      emit?.('thinking', { message: 'Starting sandbox environment...' })

      const needsNetwork = capabilities.some((c) => c.networkAccess)
      const needsDockerSocket = capabilities.some((c) => c.slug === 'docker')

      const configEnvVars = await capabilityService.getDecryptedCapabilityConfigsForWorkspace(workspaceId)
      const mergedEnvVars: Record<string, string> = {}
      for (const envMap of configEnvVars.values()) {
        Object.assign(mergedEnvVars, envMap)
      }

      await sandboxService.getOrCreateWorkspaceContainer(
        workspaceId,
        { networkAccess: needsNetwork, dockerSocket: needsDockerSocket },
        Object.keys(mergedEnvVars).length ? mergedEnvVars : undefined,
      )
      linuxUser = await sandboxService.ensureConversationUser(workspaceId, sessionId)

      // Inject sandbox context into system prompt so the LLM knows writable paths
      const sandboxContext = `\n\n## Your Sandbox Environment\n` +
        `- Username: ${linuxUser}\n` +
        `- Working directory (cwd): /workspace/users/${linuxUser}/ — all relative paths resolve here\n` +
        `- Shared outputs: /workspace/.outputs/ (writable)\n` +
        `- /workspace/ root: READ-ONLY — do not write files there directly\n` +
        `- When using sourcePath in generate_file, use the full path: /workspace/users/${linuxUser}/filename or /workspace/.outputs/filename`
      ;(messages[0] as { content: string }).content += sandboxContext
    }

    // Load auto-approve rules (global + session-scoped)
    const globalSettings = await prisma.globalSettings.findUnique({ where: { id: 'singleton' } })
    const globalRules = (globalSettings?.autoApproveRules as string[]) ?? []
    const sessionRules = (sessionData.sessionAllowRules as string[]) ?? []
    const allowRules: string[] = [...globalRules, ...sessionRules]

    const maxIterations = await settingsService.getMaxAgentIterations()
    for (let i = 0; i < maxIterations; i++) {
      debugLog(`── Iteration ${i + 1}/${maxIterations} ──`)
      emit?.('thinking', { message: 'Thinking...' })

      // Prune old tool results to reduce context size
      const prunedCount = pruneOldToolResults(messages, i)
      if (prunedCount > 0) {
        debugLog('Pruned old tool results', { prunedCount, iteration: i + 1 })
      }

      logLLMRequest(messages, tools, i + 1)
      const llmStart = Date.now()
      const response = await llm.chatWithTools(messages, { tools })
      const llmMs = Date.now() - llmStart
      logLLMResponse(response, llmMs, i + 1)

      await recordTokenUsage(response.usage, sessionId, llm.providerId, llm.modelId)

      debugLog('LLM response', {
        durationMs: llmMs,
        finishReason: response.finishReason,
        contentLength: response.content?.length ?? 0,
        contentPreview: response.content?.slice(0, 300) || '(empty)',
        toolCallCount: response.toolCalls?.length ?? 0,
        toolCalls: response.toolCalls?.map((tc) => ({
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
          debugLog(`[TOOL_SIZE] ${tc.name}`, {
            totalArgsChars: argsSize,
            commandChars: commandSize,
            linesInCommand: typeof commandArg === 'string' ? commandArg.split('\n').length : 0,
            isLarge: argsSize > LARGE_TOOL_ARG_THRESHOLD,
            preview: argsStr.slice(0, 300),
          })
          if (argsSize > LARGE_TOOL_ARG_THRESHOLD) {
            debugLog(`[TOOL_SIZE_WARN] ${tc.name} generated ${argsSize} chars (${Math.round(argsSize / 1000)}KB) — possible data embedding`, {
              firstLines: typeof commandArg === 'string' ? commandArg.split('\n').slice(0, 5).join('\n') : undefined,
              lastLines: typeof commandArg === 'string' ? commandArg.split('\n').slice(-3).join('\n') : undefined,
            })
          }
        }
      }

      // No tool calls — we're done
      if (response.finishReason === 'stop' || !response.toolCalls?.length) {
        debugLog('Agent loop DONE (no more tool calls)', {
          totalToolExecutions: toolExecutionLog.length,
          finalContentLength: response.content?.length ?? 0,
        })
        emit?.('content', { text: response.content })
        const finalContent = (accumulatedContent + (response.content || '')).trim()
        return {
          content: finalContent,
          toolExecutions: toolExecutionLog,
          sources: collectedSources.length ? collectedSources : undefined,
        }
      }

      // Emit intermediate content so the user sees what the LLM is explaining between tool calls
      if (response.content?.trim()) {
        emit?.('content', { text: response.content })
        accumulatedContent += response.content + '\n\n'
      }

      // Add assistant message with tool calls to conversation
      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      })

      // ── Helper: resolve capability for a tool call ──
      const resolveCapability = (toolCall: ToolCall) => {
        const matched = capabilities.find((cap) => {
          const defs = cap.toolDefinitions as Array<{ name: string }>
          return defs?.some((t) => t.name === toolCall.name)
        }) ?? discoveredCapabilities.find((cap) => {
          return cap.toolDefinitions?.some((t) => t.name === toolCall.name)
        })
        return {
          matchedCapability: matched,
          capabilitySlug: matched?.slug ?? (toolCall.name === 'discover_tools' ? 'tool-discovery' : 'unknown'),
        }
      }

      // ── Helper: run pre-checks (discovery, permission, size) — returns null if OK, or stops the loop ──
      const preCheckTool = async (toolCall: ToolCall, capabilitySlug: string, matchedCapability: typeof capabilities[0] | undefined) => {
        // Discovery mode: reject undiscovered tools
        if (useDiscovery && !tools.some((t) => t.name === toolCall.name)) {
          const rejection = `Tool "${toolCall.name}" is not yet available. Call discover_tools first to find and load the appropriate tools for your task.`
          debugLog(`[REJECTED] "${toolCall.name}" — not in available tools (discovery mode)`)
          emit?.('tool_start', { toolName: toolCall.name, capabilitySlug, input: toolCall.arguments })
          emit?.('tool_result', { toolName: toolCall.name, error: rejection, exitCode: 1, durationMs: 0 })
          toolExecutionLog.push({ toolName: toolCall.name, capabilitySlug, input: toolCall.arguments, error: rejection, durationMs: 0 })
          messages.push({ role: 'tool', toolCallId: toolCall.id, content: rejection })
          return 'rejected'
        }

        // Permission check
        const isAllowed = permissionService.isToolAllowed(toolCall, allowRules)
        debugLog(`Tool "${toolCall.name}" permission`, { isAllowed, capabilitySlug })

        if (!isAllowed && !options?.autoApprove) {
          const approval = await prisma.toolApproval.create({
            data: {
              chatSessionId: sessionId,
              toolName: toolCall.name,
              capabilitySlug,
              input: JSON.parse(JSON.stringify(toolCall.arguments)),
              toolCallId: toolCall.id,
            },
          })
          emit?.('approval_required', { approvalId: approval.id, toolName: toolCall.name, capabilitySlug, input: toolCall.arguments })

          const agentState: AgentState = {
            messages, iteration: i, pendingToolCalls: response.toolCalls, completedToolResults: [],
            linuxUser, toolExecutionLog, workspaceId, sessionId,
            discoveredCapabilitySlugs: discoveredCapabilities.map((c) => c.slug),
          }
          await prisma.chatSession.update({
            where: { id: sessionId },
            data: { agentState: JSON.parse(JSON.stringify(agentState)), agentStatus: 'awaiting_approval' },
          })
          const pendingApprovals = await prisma.toolApproval.findMany({
            where: { chatSessionId: sessionId, status: 'pending' },
            select: { id: true },
          })
          debugLog('Agent PAUSED — awaiting approval', { pendingCount: pendingApprovals.length })
          emit?.('awaiting_approval', { approvalIds: pendingApprovals.map((a) => a.id) })
          return 'paused'
        }

        // Size guard
        const sizeRejection = checkToolArgSize(toolCall)
        if (sizeRejection) {
          debugLog(`[BLOCKED] "${toolCall.name}" — args too large`, { size: JSON.stringify(toolCall.arguments).length })
          emit?.('tool_start', { toolName: toolCall.name, capabilitySlug, input: { _blocked: true } })
          emit?.('tool_result', { toolName: toolCall.name, error: sizeRejection, exitCode: 1, durationMs: 0 })
          toolExecutionLog.push({ toolName: toolCall.name, capabilitySlug, input: { _blocked: true }, error: sizeRejection, durationMs: 0 })
          messages.push({ role: 'tool', toolCallId: toolCall.id, content: sizeRejection })
          return 'rejected'
        }

        return 'ok'
      }

      // ── Helper: execute a single tool ──
      const executeSingleTool = async (toolCall: ToolCall, capabilitySlug: string, matchedCapability: typeof capabilities[0] | undefined) => {
        debugLog(`Executing tool "${toolCall.name}"`, { input: JSON.stringify(toolCall.arguments).slice(0, 500) })
        const isDiscoveryTool = toolCall.name === 'discover_tools'
        if (isDiscoveryTool) emit?.('thinking', { message: 'Looking for the right tools...' })
        emit?.('tool_start', { toolName: toolCall.name, capabilitySlug, input: toolCall.arguments })

        const toolStart = Date.now()
        const result = await toolExecutorService.execute(toolCall, capabilitySlug, {
          workspaceId,
          chatSessionId: sessionId,
          linuxUser: linuxUser ?? '',
          capability: matchedCapability ? {
            slug: matchedCapability.slug,
            skillType: (matchedCapability as Record<string, unknown>).skillType as string | null,
            toolDefinitions: matchedCapability.toolDefinitions,
          } : undefined,
        })

        debugLog(`Tool "${toolCall.name}" result`, {
          durationMs: Date.now() - toolStart,
          outputLength: result.output?.length ?? 0,
          outputPreview: result.output?.slice(0, 300) || '(empty)',
          error: result.error || null,
          exitCode: result.exitCode,
        })
        logToolResult(toolCall.name, result)
        return result
      }

      // ── Execute tool calls (parallel-safe tools run concurrently) ──
      // First pass: pre-check all tools, collect those ready to execute
      type ReadyTool = { toolCall: ToolCall; capabilitySlug: string; matchedCapability: typeof capabilities[0] | undefined }
      const readyTools: ReadyTool[] = []
      let paused = false

      for (const toolCall of response.toolCalls) {
        const { matchedCapability, capabilitySlug } = resolveCapability(toolCall)
        const checkResult = await preCheckTool(toolCall, capabilitySlug, matchedCapability)
        if (checkResult === 'paused') {
          paused = true
          break
        }
        if (checkResult === 'rejected') continue
        readyTools.push({ toolCall, capabilitySlug, matchedCapability })
      }

      if (paused) {
        return {
          content: accumulatedContent.trim(),
          toolExecutions: toolExecutionLog,
          sources: collectedSources.length ? collectedSources : undefined,
        }
      }

      // Second pass: execute — parallel-safe tools concurrently, others sequentially
      const parallelBatch = readyTools.filter((t) => PARALLEL_SAFE_TOOLS.has(t.toolCall.name))
      const sequentialBatch = readyTools.filter((t) => !PARALLEL_SAFE_TOOLS.has(t.toolCall.name))

      // Execute parallel-safe tools concurrently (only worth it for 2+)
      const executeAndProcess = async (batch: ReadyTool[], parallel: boolean) => {
        if (batch.length === 0) return

        const results = parallel && batch.length > 1
          ? await Promise.all(batch.map((t) => executeSingleTool(t.toolCall, t.capabilitySlug, t.matchedCapability)))
          : []

        for (let idx = 0; idx < batch.length; idx++) {
          const { toolCall, capabilitySlug } = batch[idx]
          const result = parallel && batch.length > 1
            ? results[idx]
            : await executeSingleTool(toolCall, capabilitySlug, batch[idx].matchedCapability)

          // ── Post-process: SSE events, discovery injection, message push ──
          const isDiscoveryTool = toolCall.name === 'discover_tools'

          if (isDiscoveryTool) {
            let discoveryOutput = result.output || 'No tools discovered'
            try {
              const parsed = JSON.parse(result.output ?? '{}')
              if (parsed.discovered?.length) {
                discoveryOutput = 'Discovered: ' + parsed.discovered.map((c: { name: string }) => c.name).join(', ')
              }
            } catch { /* keep raw output */ }
            emit?.('tool_result', { toolName: toolCall.name, output: discoveryOutput, durationMs: result.durationMs })
          } else {
            const ssePayload = prepareToolResultForSSE(toolCall.name, result)
            emit?.('tool_result', { toolName: toolCall.name, ...ssePayload, error: result.error, exitCode: result.exitCode, durationMs: result.durationMs })
          }

          // Collect document sources
          if (result.sources?.length) {
            for (const s of result.sources) {
              if (!collectedSources.some((cs) => cs.documentId === s.documentId)) collectedSources.push(s)
            }
            emit?.('sources', { sources: collectedSources })
          }

          // Dynamic tool injection from discover_tools
          if (toolCall.name === 'discover_tools' && useDiscovery && result.output) {
            discoveryCallCount++
            try {
              const parsed = JSON.parse(result.output)
              if (parsed.type === 'discovery_result' && parsed.discovered?.length) {
                const newCaps: typeof parsed.discovered = []
                for (const cap of parsed.discovered) {
                  if (discoveredCapabilities.some((dc) => dc.slug === cap.slug)) continue
                  newCaps.push(cap)
                  discoveredCapabilities.push({
                    slug: cap.slug, name: cap.name, toolDefinitions: cap.tools,
                    systemPrompt: cap.instructions, networkAccess: cap.networkAccess, skillType: cap.skillType,
                  })
                  for (const tool of cap.tools as ToolDefinition[]) {
                    if (!tools.some((t) => t.name === tool.name)) {
                      tools.push({ name: tool.name, description: tool.description, parameters: tool.parameters })
                    }
                  }
                }
                if (newCaps.length < parsed.discovered.length) {
                  result.output = JSON.stringify({ ...parsed, discovered: newCaps })
                }
                debugLog('Tools dynamically injected', {
                  newSlugs: newCaps.map((c: { slug: string }) => c.slug),
                  skippedDuplicates: parsed.discovered.length - newCaps.length,
                  totalTools: tools.length,
                })
              }
            } catch { /* Discovery output parse failed */ }
          }

          toolExecutionLog.push({
            toolName: toolCall.name, capabilitySlug, input: toolCall.arguments,
            output: result.output || undefined, error: result.error, exitCode: result.exitCode, durationMs: result.durationMs,
          })

          // Add tool result to conversation
          const rawContent = (toolCall.name === 'run_browser_script')
            ? result.output
            : result.error ? `Error: ${result.error}\n\n${result.output}` : result.output
          const isSandboxTool = !NON_SANDBOX_TOOLS.has(toolCall.name)
          const toolContent = (linuxUser && isSandboxTool)
            ? await maybeTruncateOutput(rawContent, toolCall.id, workspaceId, linuxUser)
            : rawContent
          const messageContent: MessageContent = toolCall.name === 'run_browser_script'
            ? buildToolResultContent(typeof toolContent === 'string' ? toolContent : toolContent, llm.modelId)
            : toolContent
          messages.push({ role: 'tool', toolCallId: toolCall.id, content: messageContent })
        }
      }

      // Execute parallel-safe tools first (concurrently), then sequential ones
      if (parallelBatch.length > 1) {
        debugLog('Executing parallel batch', { tools: parallelBatch.map((t) => t.toolCall.name) })
      }
      await executeAndProcess(parallelBatch, true)
      await executeAndProcess(sequentialBatch, false)
    }

    debugLog('Agent loop DONE (max iterations reached)', { totalToolExecutions: toolExecutionLog.length })

    const maxIterContent =
      'I reached the maximum number of tool-calling iterations. Here is what I found so far based on the tool outputs above.'
    emit?.('content', { text: maxIterContent })

    return {
      content: (accumulatedContent + maxIterContent).trim(),
      toolExecutions: toolExecutionLog,
      sources: collectedSources.length ? collectedSources : undefined,
    }
  },

  /**
   * Resume agent loop after tool approval decisions.
   */
  async resumeAgentLoop(
    sessionId: string,
    emit?: SSEEmit,
  ): Promise<AgentResult> {
    initSessionLog(sessionId)
    debugLog('resumeAgentLoop START', { sessionId })

    const session = await prisma.chatSession.findUniqueOrThrow({
      where: { id: sessionId },
    })

    const state = session.agentState as unknown as AgentState | null
    if (!state) {
      throw new Error('No agent state to resume')
    }

    // Get all decided approvals
    const approvals = await prisma.toolApproval.findMany({
      where: { chatSessionId: sessionId },
      orderBy: { createdAt: 'asc' },
    })

    debugLog('Resuming with approvals', {
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
      data: { agentState: Prisma.DbNull, agentStatus: 'running' },
    })

    const { messages, toolExecutionLog, workspaceId, linuxUser } = state
    const collectedSourcesResume: NonNullable<AgentResult['sources']> = []

    // Check if any tool was denied — if so, stop immediately
    const hasDenied = state.pendingToolCalls.some((tc) => {
      const a = approvals.find((ap) => ap.toolCallId === tc.id)
      return a?.status === 'denied'
    })

    if (hasDenied) {
      const deniedNames = state.pendingToolCalls
        .filter((tc) => approvals.find((a) => a.toolCallId === tc.id)?.status === 'denied')
        .map((tc) => tc.name)

      debugLog('Agent STOPPED — tool(s) denied', { deniedNames })

      await prisma.toolApproval.deleteMany({
        where: { chatSessionId: sessionId },
      })

      await prisma.chatSession.update({
        where: { id: sessionId },
        data: { agentStatus: 'idle' },
      })

      const rejectionContent = `Action skipped — ${deniedNames.join(', ')} was not approved.`
      emit?.('content', { text: rejectionContent })

      return {
        content: rejectionContent,
        toolExecutions: toolExecutionLog,
        sources: collectedSourcesResume.length ? collectedSourcesResume : undefined,
      }
    }

    // Pre-load capabilities for resume execution
    const resumeCapabilities = await capabilityService.getEnabledCapabilitiesForWorkspace(workspaceId)

    // Process approved tool calls
    for (const toolCall of state.pendingToolCalls) {
      const approval = approvals.find((a) => a.toolCallId === toolCall.id)
      const resumeMatchedCap = resumeCapabilities.find((cap) => {
        const defs = cap.toolDefinitions as Array<{ name: string }>
        return defs?.some((t) => t.name === toolCall.name)
      })
      const capabilitySlug = resumeMatchedCap?.slug ?? approval?.capabilitySlug ?? 'unknown'

      const isDiscoveryToolResume = toolCall.name === 'discover_tools'
      if (isDiscoveryToolResume) {
        emit?.('thinking', { message: 'Looking for the right tools...' })
      } else {
        emit?.('tool_start', { toolName: toolCall.name, capabilitySlug, input: toolCall.arguments })
      }

      const result = await toolExecutorService.execute(toolCall, capabilitySlug, {
        workspaceId,
        chatSessionId: sessionId,
        linuxUser: linuxUser ?? '',
        capability: resumeMatchedCap ? {
          slug: resumeMatchedCap.slug,
          skillType: (resumeMatchedCap as Record<string, unknown>).skillType as string | null,
          toolDefinitions: resumeMatchedCap.toolDefinitions,
        } : undefined,
      })

      logToolResult(toolCall.name, result)
      if (!isDiscoveryToolResume) {
        const resumeSsePayload = prepareToolResultForSSE(toolCall.name, result)
        emit?.('tool_result', {
          toolName: toolCall.name,
          ...resumeSsePayload,
          error: result.error,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        })
      }

      toolExecutionLog.push({
        toolName: toolCall.name,
        capabilitySlug,
        input: toolCall.arguments,
        output: result.output || undefined,
        error: result.error,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      })

      // Truncate large sandbox outputs to save context
      // For browser scripts, pass output directly to preserve JSON structure for screenshot extraction
      const rawContent = (toolCall.name === 'run_browser_script')
        ? result.output
        : result.error
          ? `Error: ${result.error}\n\n${result.output}`
          : result.output
      const isSandboxTool = !NON_SANDBOX_TOOLS.has(toolCall.name)
      const toolContent = (linuxUser && isSandboxTool)
        ? await maybeTruncateOutput(rawContent, toolCall.id, workspaceId, linuxUser)
        : rawContent
      messages.push({
        role: 'tool',
        toolCallId: toolCall.id,
        content: toolContent,
      })
    }

    // LLM needed below for multimodal handling
    const llm = await createLLMProvider()

    // Clean up approvals
    await prisma.toolApproval.deleteMany({
      where: { chatSessionId: sessionId },
    })

    // Continue the agent loop from where we left off (reuse pre-loaded capabilities)
    const capabilities = resumeCapabilities
    const tools = capabilityService.buildToolDefinitions(capabilities)

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
      emit?.('thinking', { message: 'Thinking...' })

      // Prune old tool results to reduce context size
      const prunedCount = pruneOldToolResults(messages, i)
      if (prunedCount > 0) {
        debugLog('Pruned old tool results (resume)', { prunedCount, iteration: i + 1 })
      }

      logLLMRequest(messages, tools, i + 1)
      const llmStart = Date.now()
      const response = await llm.chatWithTools(messages, { tools })
      const llmMs = Date.now() - llmStart
      logLLMResponse(response, llmMs, i + 1)

      await recordTokenUsage(response.usage, sessionId, llm.providerId, llm.modelId)

      debugLog('LLM response (resume)', {
        durationMs: llmMs,
        finishReason: response.finishReason,
        contentLength: response.content?.length ?? 0,
        toolCallCount: response.toolCalls?.length ?? 0,
      })

      // Log tool call argument sizes for debugging large LLM outputs
      if (response.toolCalls?.length) {
        for (const tc of response.toolCalls) {
          const argsStr = JSON.stringify(tc.arguments)
          const argsSize = argsStr.length
          const commandArg = tc.arguments?.command ?? tc.arguments?.code ?? tc.arguments?.content
          const commandSize = typeof commandArg === 'string' ? commandArg.length : 0
          debugLog(`[TOOL_SIZE] ${tc.name}`, {
            totalArgsChars: argsSize,
            commandChars: commandSize,
            linesInCommand: typeof commandArg === 'string' ? commandArg.split('\n').length : 0,
            isLarge: argsSize > LARGE_TOOL_ARG_THRESHOLD,
          })
          if (argsSize > LARGE_TOOL_ARG_THRESHOLD) {
            debugLog(`[TOOL_SIZE_WARN] ${tc.name} generated ${argsSize} chars (${Math.round(argsSize / 1000)}KB) — possible data embedding`)
          }
        }
      }

      if (response.finishReason === 'stop' || !response.toolCalls?.length) {
        emit?.('content', { text: response.content })

        await prisma.chatSession.update({
          where: { id: sessionId },
          data: { agentStatus: 'idle' },
        })

        return {
          content: response.content,
          toolExecutions: toolExecutionLog,
          sources: collectedSourcesResume.length ? collectedSourcesResume : undefined,
        }
      }

      // Emit intermediate content so the user sees what the LLM is explaining between tool calls
      if (response.content?.trim()) {
        emit?.('content', { text: response.content })
      }

      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      })

      for (const toolCall of response.toolCalls) {
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
              input: JSON.parse(JSON.stringify(toolCall.arguments)),
              toolCallId: toolCall.id,
            },
          })

          emit?.('approval_required', {
            approvalId: approval.id,
            toolName: toolCall.name,
            capabilitySlug,
            input: toolCall.arguments,
          })

          const agentState: AgentState = {
            messages,
            iteration: i,
            pendingToolCalls: response.toolCalls,
            completedToolResults: [],
            linuxUser,
            toolExecutionLog,
            workspaceId,
            sessionId,
          }

          await prisma.chatSession.update({
            where: { id: sessionId },
            data: {
              agentState: JSON.parse(JSON.stringify(agentState)),
              agentStatus: 'awaiting_approval',
            },
          })

          const pending = await prisma.toolApproval.findMany({
            where: { chatSessionId: sessionId, status: 'pending' },
            select: { id: true },
          })

          emit?.('awaiting_approval', { approvalIds: pending.map((a) => a.id) })
          return { content: '', toolExecutions: toolExecutionLog, sources: collectedSourcesResume.length ? collectedSourcesResume : undefined }
        }

        // Guard: reject oversized tool call arguments
        const sizeRejection = checkToolArgSize(toolCall)
        if (sizeRejection) {
          debugLog(`[BLOCKED] "${toolCall.name}" — args too large (resume)`, { size: JSON.stringify(toolCall.arguments).length })
          emit?.('tool_start', { toolName: toolCall.name, capabilitySlug, input: { _blocked: true } })
          emit?.('tool_result', { toolName: toolCall.name, error: sizeRejection, exitCode: 1, durationMs: 0 })
          toolExecutionLog.push({ toolName: toolCall.name, capabilitySlug, input: { _blocked: true }, error: sizeRejection, durationMs: 0 })
          messages.push({ role: 'tool', toolCallId: toolCall.id, content: sizeRejection })
          continue
        }

        const isDiscoveryToolLoop = toolCall.name === 'discover_tools'
        if (isDiscoveryToolLoop) {
          emit?.('thinking', { message: 'Looking for the right tools...' })
        } else {
          emit?.('tool_start', { toolName: toolCall.name, capabilitySlug, input: toolCall.arguments })
        }

        const result = await toolExecutorService.execute(toolCall, capabilitySlug, {
          workspaceId,
          chatSessionId: sessionId,
          linuxUser: linuxUser ?? '',
          capability: matchedCap ? {
            slug: matchedCap.slug,
            skillType: (matchedCap as Record<string, unknown>).skillType as string | null,
            toolDefinitions: matchedCap.toolDefinitions,
          } : undefined,
        })

        logToolResult(toolCall.name, result)
        if (!isDiscoveryToolLoop) {
          const resumeLoopSsePayload = prepareToolResultForSSE(toolCall.name, result)
          emit?.('tool_result', {
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
          input: toolCall.arguments,
          output: result.output || undefined,
          error: result.error,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        })

        // Truncate large outputs to save context
        // For browser scripts, pass output directly to preserve JSON structure for screenshot extraction
        const rawContent = (toolCall.name === 'run_browser_script')
          ? result.output
          : result.error
            ? `Error: ${result.error}\n\n${result.output}`
            : result.output
        // Only truncate sandbox tool outputs — non-sandbox tools (search, memory, web) return full results
        const isSandboxTool = !NON_SANDBOX_TOOLS.has(toolCall.name)
        const toolContent = (linuxUser && isSandboxTool)
          ? await maybeTruncateOutput(rawContent, toolCall.id, workspaceId, linuxUser)
          : rawContent
        // For browser scripts, check if result contains screenshot for multimodal handling
        const resumeMessageContent: MessageContent = toolCall.name === 'run_browser_script'
          ? buildToolResultContent(typeof toolContent === 'string' ? toolContent : toolContent, llm.modelId)
          : toolContent
        messages.push({
          role: 'tool',
          toolCallId: toolCall.id,
          content: resumeMessageContent,
        })
      }
    }

    await prisma.chatSession.update({
      where: { id: sessionId },
      data: { agentStatus: 'idle' },
    })

    const maxIterContent =
      'I reached the maximum number of tool-calling iterations. Here is what I found so far.'
    emit?.('content', { text: maxIterContent })

    return { content: maxIterContent, toolExecutions: toolExecutionLog, sources: collectedSourcesResume.length ? collectedSourcesResume : undefined }
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
