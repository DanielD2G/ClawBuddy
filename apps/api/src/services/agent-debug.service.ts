import { mkdirSync, appendFileSync } from 'fs'
import { join } from 'path'
import type { ChatMessage, LLMToolDefinition, LLMResponse } from '../providers/llm.interface.js'
import { getTextContent } from '../providers/llm.interface.js'
import type { SecretInventory } from './secret-redaction.service.js'
import { secretRedactionService } from './secret-redaction.service.js'
import { logger as appLogger } from '../lib/logger.js'

export const DEBUG = process.env.DEBUG_AGENT === '1' || process.env.DEBUG === '1'

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

/**
 * Per-session debug logger. Keeps log file path and inventory as instance state
 * to avoid module-level mutable globals (which race across concurrent requests).
 */
export interface SessionLogger {
  debugLog(label: string, data?: unknown): void
  logLLMRequest(messages: ChatMessage[], tools: LLMToolDefinition[], iteration: number): void
  logLLMResponse(response: LLMResponse, durationMs: number, iteration: number): void
  logToolResult(
    toolName: string,
    result: { output?: string; error?: string; exitCode?: number; durationMs: number },
  ): void
}

export function createSessionLogger(sessionId: string, inventory: SecretInventory): SessionLogger {
  let logFile: string | null = null
  if (DEBUG) {
    ensureLogDir()
    const dateStr = new Date().toISOString().slice(0, 10)
    logFile = join(DEBUG_LOG_DIR, `${dateStr}_${sessionId}.log`)
  }

  function redact<T>(value: T): T {
    return secretRedactionService.redactForPublicStorage(value as never, inventory) as T
  }

  function writeLine(line: string) {
    appLogger.debug(line)
    if (logFile) {
      try {
        appendFileSync(logFile, line + '\n')
      } catch {
        /* ignore */
      }
    }
  }

  function writeBlock(lines: string[]) {
    if (logFile) {
      try {
        appendFileSync(logFile, lines.join('\n') + '\n')
      } catch {
        /* ignore */
      }
    }
  }

  const logger: SessionLogger = {
    debugLog(label, data) {
      if (!DEBUG) return
      const ts = new Date().toISOString().slice(11, 23)
      const safeData = data !== undefined ? redact(data) : undefined
      const dataStr =
        data !== undefined
          ? typeof safeData === 'string'
            ? safeData
            : JSON.stringify(safeData, null, 2)
          : ''
      writeLine(dataStr ? `[Agent ${ts}] ${label} ${dataStr}` : `[Agent ${ts}] ${label}`)
    },

    logLLMRequest(messages, tools, iteration) {
      if (!DEBUG || !logFile) return
      const safeMessages = redact(messages)
      const safeTools = redact(tools)
      const separator = `\n${'─'.repeat(80)}\n`
      writeBlock([
        separator,
        `>>> LLM REQUEST (iteration ${iteration})`,
        `>>> ${safeMessages.length} messages, ${safeTools.length} tools`,
        separator,
        '>>> SYSTEM PROMPT:',
        getTextContent(safeMessages[0]?.content ?? '').slice(0, 5000),
        separator,
        '>>> TOOLS:',
        safeTools.map((t) => `  - ${t.name}: ${t.description.slice(0, 120)}`).join('\n'),
        separator,
        '>>> MESSAGES (last 5):',
        ...safeMessages.slice(-5).map((m) => {
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          const preview = content.slice(0, 1000)
          const toolCallsSummary =
            m.toolCalls
              ?.map(
                (tc) =>
                  `    [tool_call: ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 200)})]`,
              )
              .join('\n') ?? ''
          return `  [${m.role}${m.toolCallId ? ` toolCallId=${m.toolCallId}` : ''}] ${preview}${content.length > 1000 ? `... (${content.length} chars)` : ''}${toolCallsSummary ? '\n' + toolCallsSummary : ''}`
        }),
        separator,
      ])
    },

    logLLMResponse(response, durationMs, iteration) {
      if (!DEBUG || !logFile) return
      const safeResponse = redact(response)
      const separator = `\n${'─'.repeat(80)}\n`
      writeBlock([
        separator,
        `<<< LLM RESPONSE (iteration ${iteration}, ${durationMs}ms)`,
        `<<< finishReason: ${safeResponse.finishReason}`,
        `<<< usage: ${safeResponse.usage ? `in=${safeResponse.usage.inputTokens} out=${safeResponse.usage.outputTokens} total=${safeResponse.usage.totalTokens}` : 'n/a'}`,
        separator,
        '<<< CONTENT:',
        safeResponse.content || '(empty)',
        ...(safeResponse.toolCalls?.length
          ? [
              separator,
              '<<< TOOL CALLS:',
              ...safeResponse.toolCalls.map(
                (tc) => `  - ${tc.name}(${JSON.stringify(tc.arguments, null, 2)})`,
              ),
            ]
          : []),
        separator,
      ])
    },

    logToolResult(toolName, result) {
      if (!DEBUG || !logFile) return
      const safeResult = redact(result)
      writeBlock(
        [
          `  ┌── TOOL RESULT: ${toolName} (${safeResult.durationMs}ms, exit=${safeResult.exitCode ?? 'n/a'})`,
          safeResult.error ? `  │ ERROR: ${safeResult.error}` : '',
          `  │ OUTPUT (${safeResult.output?.length ?? 0} chars):`,
          `  │ ${(safeResult.output ?? '').slice(0, 2000)}${(safeResult.output?.length ?? 0) > 2000 ? `\n  │ ... (truncated)` : ''}`,
          `  └──`,
        ].filter(Boolean),
      )
    },
  }

  logger.debugLog('═══ Session log initialized ═══')
  return logger
}
