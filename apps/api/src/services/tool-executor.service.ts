import { prisma } from '../lib/prisma.js'
import type { Prisma } from '@prisma/client'
import type { ToolCall } from '../providers/llm.interface.js'
import { stripNullBytesOrNull } from '../lib/sanitize.js'
import { extractScreenshotBase64 } from '../lib/screenshot.js'
import { secretRedactionService } from './secret-redaction.service.js'
import { logger } from '../lib/logger.js'

// Re-export types so existing imports continue to work
export type {
  ExecutionContext,
  ExecutionResult,
  DocumentSource,
  ToolHandler,
} from './tools/handler-utils.js'
import type { ExecutionContext, ExecutionResult, ToolHandler } from './tools/handler-utils.js'

// Import domain handlers
import {
  executeDocumentSearch,
  executeSaveDocument,
  executeGenerateFile,
  executeReadFile,
} from './tools/document.handler.js'
import { executeWebFetch, executeWebSearch } from './tools/fetch.handler.js'
import { executeBrowserScript } from './tools/browser.handler.js'
import { executeSandboxCommand } from './tools/sandbox.handler.js'
import {
  executeCreateCron,
  executeListCrons,
  executeDeleteCron,
  executeDiscoverTools,
  executeDelegateTask,
} from './tools/system.handler.js'

// ---------------------------------------------------------------------------
// Tool handler registry — maps tool names to their handler functions
// ---------------------------------------------------------------------------

const toolHandlerRegistry = new Map<string, ToolHandler>([
  ['search_documents', executeDocumentSearch],
  ['save_document', executeSaveDocument],
  ['generate_file', executeGenerateFile],
  ['read_file', executeReadFile],
  ['create_cron', executeCreateCron],
  ['list_crons', (_toolCall, context) => executeListCrons(context)],
  ['delete_cron', (toolCall, _context) => executeDeleteCron(toolCall)],
  ['web_search', (toolCall, _context) => executeWebSearch(toolCall)],
  ['web_fetch', (toolCall, _context) => executeWebFetch(toolCall)],
  ['run_browser_script', executeBrowserScript],
  ['discover_tools', executeDiscoverTools],
  ['delegate_task', executeDelegateTask],
])

/**
 * Tools that have custom (non-sandbox) execution logic.
 * Derived from the registry keys so it stays in sync automatically.
 */
export const NON_SANDBOX_TOOLS = new Set(toolHandlerRegistry.keys())

// ---------------------------------------------------------------------------
// Exported service object — preserves the same public API
// ---------------------------------------------------------------------------

export const toolExecutorService = {
  /**
   * Execute a tool call, routing to the appropriate handler.
   */
  async execute(
    toolCall: ToolCall,
    capabilitySlug: string,
    context: ExecutionContext,
  ): Promise<ExecutionResult> {
    const startTime = Date.now()
    const inventory =
      context.secretInventory ??
      (await secretRedactionService.buildSecretInventory(context.workspaceId))
    const publicInput = secretRedactionService.redactForPublicStorage(
      toolCall.arguments as Record<string, unknown>,
      inventory,
    )

    try {
      // Strategy lookup: use registered handler or fall back to sandbox
      const handler = toolHandlerRegistry.get(toolCall.name)
      const result = handler
        ? await handler(toolCall, context)
        : await executeSandboxCommand(toolCall, capabilitySlug, context)

      // Extract screenshot from browser tool output before saving
      let screenshotData: string | null = null
      let outputForDb = result.output
      if (toolCall.name === 'run_browser_script' && result.output) {
        const { screenshotB64, description } = extractScreenshotBase64(result.output)
        if (screenshotB64) {
          screenshotData = `data:image/jpeg;base64,${screenshotB64}`
          outputForDb = description || 'Screenshot captured'
        }
      }

      const publicOutput = result.output
        ? secretRedactionService.redactSerializedText(result.output, inventory, {
            skipKeys: ['screenshot'],
          })
        : ''
      const publicDbOutput = outputForDb
        ? secretRedactionService.redactSerializedText(outputForDb, inventory, {
            skipKeys: ['screenshot'],
          })
        : null
      const publicError = result.error
        ? secretRedactionService.redactSerializedText(result.error, inventory, {
            skipKeys: ['screenshot'],
          })
        : undefined

      // Record execution (sanitize output to strip null bytes)
      const execution = await prisma.toolExecution.create({
        data: {
          capabilitySlug,
          toolName: toolCall.name,
          input: publicInput as Prisma.InputJsonValue,
          output: stripNullBytesOrNull(publicDbOutput),
          screenshot: screenshotData,
          error: stripNullBytesOrNull(publicError),
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          status: result.error ? 'failed' : 'completed',
        },
      })

      return {
        ...result,
        output: publicOutput,
        error: publicError,
        executionId: execution.id,
      }
    } catch (err) {
      const durationMs = Date.now() - startTime
      const rawError = err instanceof Error ? err.message : String(err)
      const error = secretRedactionService.redactSerializedText(rawError, inventory)
      logger.error(`[ToolExecutor] Tool "${toolCall.name}" threw`, error)

      let executionId: string | undefined
      try {
        const execution = await prisma.toolExecution.create({
          data: {
            capabilitySlug,
            toolName: toolCall.name,
            input: publicInput as Prisma.InputJsonValue,
            error: stripNullBytesOrNull(error),
            durationMs,
            status: 'failed',
          },
        })
        executionId = execution.id
      } catch {
        // If recording the execution also fails, just log and continue
        logger.error(`[ToolExecutor] Failed to record execution error for ${toolCall.name}`, error)
      }

      return { output: '', error, durationMs, executionId }
    }
  },

  /**
   * Check if any tool in a list requires a sandbox.
   */
  needsSandbox(toolNames: string[]): boolean {
    return toolNames.some((name) => !NON_SANDBOX_TOOLS.has(name))
  },
}
