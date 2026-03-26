import type { ToolCall } from '../../providers/llm.interface.js'
import { browserService } from '../browser.service.js'
import { sandboxService } from '../sandbox.service.js'
import { extractScreenshotBase64 } from '../../lib/screenshot.js'
import type { ExecutionContext, ExecutionResult } from './handler-utils.js'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Execute a Playwright script via BrowserGrid.
 */
export async function executeBrowserScript(
  toolCall: ToolCall,
  context: ExecutionContext,
): Promise<ExecutionResult> {
  const startTime = Date.now()
  const args = toolCall.arguments as Record<string, unknown>
  const script = String(args.script ?? '')
  const timeout = Math.min(Math.max(Number(args.timeout) || 30, 5), 120)

  if (!script.trim()) {
    return { output: '', error: 'Script is required', durationMs: Date.now() - startTime }
  }

  const sessionKey = context.browserSessionId ?? context.chatSessionId
  const result = await browserService.executeScript(sessionKey, script, timeout)

  if (result.success) {
    let output = result.result ?? 'Script completed.'
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>
      if (parsed.__saveScreenshot === true) {
        if (!context.workspaceId) {
          return {
            output: '',
            error: 'saveScreenshot() requires an active sandbox session.',
            durationMs: Date.now() - startTime,
          }
        }

        const screenshotB64 =
          typeof parsed.screenshot === 'string'
            ? parsed.screenshot
            : extractScreenshotBase64(output).screenshotB64
        if (!screenshotB64) {
          return {
            output: '',
            error: 'saveScreenshot() did not produce screenshot data.',
            durationMs: Date.now() - startTime,
          }
        }

        const suggestedName =
          typeof parsed.filename === 'string' && parsed.filename.trim()
            ? path.posix.basename(parsed.filename.trim())
            : `browser-screenshot-${randomUUID()}.jpg`
        const baseName = suggestedName.replace(/\.[^.]+$/i, '')
        const resolvedPath = `/workspace/screenshots/${baseName}-${randomUUID()}.jpg`
        try {
          const imageBuffer = Buffer.from(screenshotB64, 'base64')
          await sandboxService.writeFileToContainer(context.workspaceId, resolvedPath, imageBuffer)
        } catch (writeErr) {
          return {
            output: '',
            error: `Failed to save screenshot to ${resolvedPath}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
            durationMs: Date.now() - startTime,
          }
        }

        delete parsed.__saveScreenshot
        delete parsed.screenshot
        delete parsed.filename
        parsed.savedPath = resolvedPath
        output = JSON.stringify(parsed, null, 2)
      }
    } catch {
      // Non-JSON browser output is returned as-is.
    }

    return {
      output,
      durationMs: Date.now() - startTime,
    }
  }

  // On error, include screenshot if available (as JSON so agent service can detect it)
  let output = `Error: ${result.error}`
  if (result.screenshotBase64) {
    output = JSON.stringify({
      error: result.error,
      screenshot: result.screenshotBase64,
      description: `Browser script failed: ${result.error}. Screenshot of current page state attached.`,
    })
  }

  return {
    output,
    error: result.error,
    durationMs: Date.now() - startTime,
  }
}
