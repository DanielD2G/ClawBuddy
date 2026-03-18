import type { ChatMessage, MessageContent, ContentBlock } from '../providers/llm.interface.js'
import { extractScreenshotBase64 } from '../lib/screenshot.js'
import { sandboxService } from './sandbox.service.js'
import {
  OUTPUT_TRUNCATE_THRESHOLD,
  MAX_SCREENSHOT_SSE_SIZE,
  TOOL_RESULT_PROTECTION_WINDOW,
  MIN_PRUNE_SIZE,
  TOKEN_ESTIMATION_DIVISOR,
} from '../constants.js'
import { VISION_MODELS } from '../config.js'

/**
 * Build a multimodal tool result message if the output contains a base64 screenshot.
 * Returns ContentBlock[] if screenshot found and model supports vision, otherwise returns the text string.
 */
export function buildToolResultContent(output: string, modelId: string): MessageContent {
  const { screenshotB64, description } = extractScreenshotBase64(output)

  if (screenshotB64) {
    if (VISION_MODELS.has(modelId)) {
      const blocks: ContentBlock[] = []
      if (description) {
        blocks.push({ type: 'text', text: String(description) })
      }
      blocks.push({
        type: 'image',
        source: { type: 'base64', mediaType: 'image/jpeg', data: screenshotB64 },
      })
      return blocks
    }
    return description ?? 'Screenshot captured but the current model does not support vision.'
  }
  return output
}

/**
 * If output exceeds threshold, save it to a file in the sandbox and return a truncated version.
 */
export async function maybeTruncateOutput(
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

  const headSize = Math.floor(OUTPUT_TRUNCATE_THRESHOLD * 0.6)
  const tailSize = OUTPUT_TRUNCATE_THRESHOLD - headSize
  const head = output.slice(0, headSize)
  const tail = output.slice(-tailSize)
  const preview = `${head}\n\n... [TRUNCATED — ${output.length - headSize - tailSize} chars omitted] ...\n\n${tail}`
  return `${preview}\n\n⚠️ OUTPUT TRUNCATED (${output.length} chars) — full result saved to ${filename}\nIMPORTANT: Do NOT re-run this command. Use \`cat ${filename}\` or pipe through jq/grep/awk to process the saved file.\nDo NOT embed or echo the data — reference the file path directly.`
}

/**
 * Prepare tool result for SSE emission — strips large base64 screenshots
 * from the output field and sends them as a separate `screenshot` field.
 */
export function prepareToolResultForSSE(
  toolName: string,
  result: { output?: string },
): { output?: string; screenshot?: string } {
  if (toolName !== 'run_browser_script' || !result.output) {
    return { output: result.output }
  }

  const { screenshotB64, description } = extractScreenshotBase64(result.output)

  if (screenshotB64) {
    if (screenshotB64.length > MAX_SCREENSHOT_SSE_SIZE) {
      return { output: description || 'Screenshot captured (too large to display)' }
    }
    const desc = description || 'Screenshot captured'
    return {
      output: typeof desc === 'string' ? desc : 'Screenshot captured',
      screenshot: `data:image/jpeg;base64,${screenshotB64}`,
    }
  }

  return { output: result.output }
}

/**
 * Prune old tool results from the messages array to reduce context size.
 * Protects the most recent tool outputs (within TOOL_RESULT_PROTECTION_WINDOW tokens)
 * and replaces older ones with placeholders.
 */
export function pruneOldToolResults(messages: ChatMessage[], iteration: number): number {
  if (iteration < 3) return 0

  // Build a set of toolCallIds that belong to delegate_task calls (sub-agent results)
  // These should never be pruned since re-running a sub-agent is expensive
  const delegateTaskCallIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (tc.name === 'delegate_task') delegateTaskCallIds.add(tc.id)
      }
    }
  }

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

    // Never prune sub-agent results — re-running delegation is expensive
    if (msg.toolCallId && delegateTaskCallIds.has(msg.toolCallId)) continue

    // Beyond protection window — prune if large enough
    if (content.length <= MIN_PRUNE_SIZE) continue
    ;(msg as { content: string }).content =
      `[Tool result cleared — was ${content.length} chars. Re-run the tool if needed.]`
    pruned++
  }

  return pruned
}
