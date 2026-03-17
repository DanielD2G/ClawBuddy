/**
 * Extract a base64-encoded screenshot from a JSON tool output string.
 * Handles both raw base64 strings and Buffer-serialized screenshots.
 *
 * Returns null values if the output is not JSON or contains no screenshot.
 */
export function extractScreenshotBase64(output: string): {
  screenshotB64: string | null
  description: string | null
} {
  try {
    const parsed = JSON.parse(output)
    let screenshotB64: string | null = null

    if (parsed?.screenshot && typeof parsed.screenshot === 'string') {
      screenshotB64 = parsed.screenshot
    } else if (parsed?.screenshot?.type === 'Buffer' && Array.isArray(parsed.screenshot.data)) {
      screenshotB64 = Buffer.from(parsed.screenshot.data).toString('base64')
    }

    if (screenshotB64) {
      const description = parsed.description || parsed.content || null
      return { screenshotB64, description }
    }
  } catch {
    // Not JSON — no screenshot to extract
  }

  return { screenshotB64: null, description: null }
}
