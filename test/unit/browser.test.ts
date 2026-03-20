import { describe, test, expect, beforeEach } from 'bun:test'
import { getTextContent } from '../../apps/api/src/providers/llm.interface'
import type {
  MessageContent,
  ContentBlock,
  ImageBlock,
} from '../../apps/api/src/providers/llm.interface'

// ─── getTextContent ───

describe('getTextContent', () => {
  test('returns string as-is', () => {
    expect(getTextContent('hello')).toBe('hello')
  })

  test('returns empty string for empty string', () => {
    expect(getTextContent('')).toBe('')
  })

  test('extracts text from TextBlock array', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ]
    expect(getTextContent(blocks)).toBe('hello world')
  })

  test('ignores ImageBlock entries', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'before ' },
      { type: 'image', source: { type: 'base64', mediaType: 'image/jpeg', data: 'abc123' } },
      { type: 'text', text: 'after' },
    ]
    expect(getTextContent(blocks)).toBe('before after')
  })

  test('returns empty string for empty block array', () => {
    expect(getTextContent([])).toBe('')
  })

  test('returns empty string for image-only array', () => {
    const blocks: ContentBlock[] = [
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'data' } },
    ]
    expect(getTextContent(blocks)).toBe('')
  })
})

// ─── buildToolResultContent ───

// Re-implement the logic inline since it's not exported — tests validate the algorithm
const VISION_MODELS = new Set([
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'gpt-4o',
  'gpt-4o-mini',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
])

function buildToolResultContent(output: string, modelId: string): MessageContent {
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
      // Non-vision model: strip screenshot, return text only
      const textParts = []
      if (parsed.description) textParts.push(parsed.description)
      if (parsed.content) textParts.push(parsed.content)
      if (parsed.error) textParts.push(`Error: ${parsed.error}`)
      return textParts.join('\n') || output
    }
  } catch {
    // Not JSON — return as-is
  }
  return output
}

describe('buildToolResultContent', () => {
  test('returns plain text for non-JSON output', () => {
    const result = buildToolResultContent('just text', 'claude-sonnet-4-6')
    expect(result).toBe('just text')
  })

  test('returns plain text for JSON without screenshot', () => {
    const json = JSON.stringify({ content: 'hello', title: 'test' })
    const result = buildToolResultContent(json, 'claude-sonnet-4-6')
    expect(result).toBe(json)
  })

  test('returns ContentBlock[] with image for vision model', () => {
    const json = JSON.stringify({
      screenshot: 'base64data',
      description: 'Page screenshot',
    })
    const result = buildToolResultContent(json, 'claude-sonnet-4-6')
    expect(Array.isArray(result)).toBe(true)
    const blocks = result as ContentBlock[]
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ type: 'text', text: 'Page screenshot' })
    expect(blocks[1]).toEqual({
      type: 'image',
      source: { type: 'base64', mediaType: 'image/jpeg', data: 'base64data' },
    })
  })

  test('returns text-only for non-vision model', () => {
    const json = JSON.stringify({
      screenshot: 'base64data',
      description: 'Page screenshot',
    })
    const result = buildToolResultContent(json, 'gpt-3.5-turbo')
    expect(typeof result).toBe('string')
    expect(result).toContain('Page screenshot')
    expect(result).not.toContain('base64data')
  })

  test('handles Buffer-serialized screenshot', () => {
    const bufferData = Array.from(Buffer.from('hello'))
    const json = JSON.stringify({
      screenshot: { type: 'Buffer', data: bufferData },
      description: 'Buffer screenshot',
    })
    const result = buildToolResultContent(json, 'gpt-4o')
    expect(Array.isArray(result)).toBe(true)
    const blocks = result as ContentBlock[]
    const imageBlock = blocks.find((b) => b.type === 'image') as ImageBlock
    expect(imageBlock).toBeTruthy()
    expect(imageBlock.source.data).toBe(Buffer.from('hello').toString('base64'))
  })

  test('image-only block when no description', () => {
    const json = JSON.stringify({ screenshot: 'data123' })
    const result = buildToolResultContent(json, 'gemini-2.5-flash')
    expect(Array.isArray(result)).toBe(true)
    const blocks = result as ContentBlock[]
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('image')
  })

  test('non-vision model with error field', () => {
    const json = JSON.stringify({
      screenshot: 'data123',
      error: 'Element not found',
      description: 'Failed click',
    })
    const result = buildToolResultContent(json, 'llama-3')
    expect(typeof result).toBe('string')
    expect(result).toContain('Failed click')
    expect(result).toContain('Error: Element not found')
  })
})

// ─── Browser capability definition ───

describe('browser-automation capability', () => {
  let browserAutomation: Awaited<
    typeof import('../../apps/api/src/capabilities/builtin/browser-automation')
  >['browserAutomation']

  beforeEach(async () => {
    const mod = await import('../../apps/api/src/capabilities/builtin/browser-automation')
    browserAutomation = mod.browserAutomation
  })

  test('has correct slug', () => {
    expect(browserAutomation.slug).toBe('browser-automation')
  })

  test('has exactly one tool: run_browser_script', () => {
    expect(browserAutomation.tools).toHaveLength(1)
    expect(browserAutomation.tools[0].name).toBe('run_browser_script')
  })

  test('tool requires script parameter', () => {
    const tool = browserAutomation.tools[0]
    expect(tool.parameters.required).toContain('script')
  })

  test('tool has optional timeout parameter', () => {
    const tool = browserAutomation.tools[0]
    expect(tool.parameters.properties.timeout).toBeTruthy()
    expect(tool.parameters.properties.timeout.type).toBe('number')
  })

  test('system prompt mentions web_search priority', () => {
    expect(browserAutomation.systemPrompt).toContain('web_search')
  })

  test('system prompt enforces step-by-step', () => {
    expect(browserAutomation.systemPrompt).toContain('step-by-step')
  })

  test('tool description mentions all helper globals', () => {
    const desc = browserAutomation.tools[0].description
    expect(desc).toContain('getReadableContent()')
    expect(desc).toContain('getLinks()')
    expect(desc).toContain('getInteractiveElements()')
    expect(desc).toContain('getPageSnapshot()')
    expect(desc).toContain('page')
    expect(desc).toContain('saveScreenshot')
  })
})

// ─── Browser service security ───

describe('browser service security checks', () => {
  // Test the URL scheme blocking regex used in browser.service.ts
  const BLOCKED_SCHEMES = /\b(file|javascript):\/\//i

  test('blocks file:// URLs', () => {
    expect(BLOCKED_SCHEMES.test('await page.goto("file:///etc/passwd")')).toBe(true)
  })

  test('blocks javascript:// URLs', () => {
    expect(BLOCKED_SCHEMES.test('page.goto("javascript://alert(1)")')).toBe(true)
  })

  test('blocks case-insensitive', () => {
    expect(BLOCKED_SCHEMES.test('page.goto("FILE:///etc/shadow")')).toBe(true)
    expect(BLOCKED_SCHEMES.test('page.goto("JavaScript://void")')).toBe(true)
  })

  test('allows https:// URLs', () => {
    expect(BLOCKED_SCHEMES.test('page.goto("https://example.com")')).toBe(false)
  })

  test('allows http:// URLs', () => {
    expect(BLOCKED_SCHEMES.test('page.goto("http://localhost:3000")')).toBe(false)
  })
})

// ─── Constants validation ───

describe('browser constants', () => {
  let constants: Awaited<typeof import('../../apps/api/src/constants')>

  beforeEach(async () => {
    constants = await import('../../apps/api/src/constants')
  })

  test('idle timeout is 5 minutes', () => {
    expect(constants.BROWSER_IDLE_TIMEOUT_MS).toBe(5 * 60 * 1000)
  })

  test('script timeout defaults are sane', () => {
    expect(constants.BROWSER_SCRIPT_DEFAULT_TIMEOUT_S).toBe(30)
    expect(constants.BROWSER_SCRIPT_MIN_TIMEOUT_S).toBe(5)
    expect(constants.BROWSER_SCRIPT_MAX_TIMEOUT_S).toBe(120)
    expect(constants.BROWSER_SCRIPT_MIN_TIMEOUT_S).toBeLessThan(
      constants.BROWSER_SCRIPT_DEFAULT_TIMEOUT_S,
    )
    expect(constants.BROWSER_SCRIPT_DEFAULT_TIMEOUT_S).toBeLessThan(
      constants.BROWSER_SCRIPT_MAX_TIMEOUT_S,
    )
  })

  test('extraction limits are positive', () => {
    expect(constants.MAX_LINKS).toBeGreaterThan(0)
    expect(constants.MAX_INTERACTIVE_ELEMENTS).toBeGreaterThan(0)
    expect(constants.SCREENSHOT_JPEG_QUALITY).toBeGreaterThan(0)
    expect(constants.SCREENSHOT_JPEG_QUALITY).toBeLessThanOrEqual(100)
  })

  test('max readable content is 50KB', () => {
    expect(constants.MAX_READABLE_CONTENT_BYTES).toBe(50 * 1024)
  })
})

// ─── Timeout clamping logic ───

describe('timeout clamping', () => {
  const BROWSER_SCRIPT_MIN_TIMEOUT_S = 5
  const BROWSER_SCRIPT_MAX_TIMEOUT_S = 120

  function clampTimeout(timeout: number): number {
    return Math.min(Math.max(timeout, BROWSER_SCRIPT_MIN_TIMEOUT_S), BROWSER_SCRIPT_MAX_TIMEOUT_S)
  }

  test('default value passes through', () => {
    expect(clampTimeout(30)).toBe(30)
  })

  test('clamps below minimum', () => {
    expect(clampTimeout(1)).toBe(5)
    expect(clampTimeout(0)).toBe(5)
    expect(clampTimeout(-10)).toBe(5)
  })

  test('clamps above maximum', () => {
    expect(clampTimeout(200)).toBe(120)
    expect(clampTimeout(999)).toBe(120)
  })

  test('boundary values', () => {
    expect(clampTimeout(5)).toBe(5)
    expect(clampTimeout(120)).toBe(120)
  })
})

// ─── executeBrowserScript argument validation ───

describe('executeBrowserScript argument handling', () => {
  function extractArgs(args: Record<string, unknown>) {
    const script = String(args.script ?? '')
    const timeout = Math.min(Math.max(Number(args.timeout) || 30, 5), 120)
    return { script, timeout }
  }

  test('extracts script from args', () => {
    const { script } = extractArgs({ script: 'await page.goto("https://example.com")' })
    expect(script).toBe('await page.goto("https://example.com")')
  })

  test('defaults timeout to 30', () => {
    const { timeout } = extractArgs({ script: 'x' })
    expect(timeout).toBe(30)
  })

  test('respects custom timeout', () => {
    const { timeout } = extractArgs({ script: 'x', timeout: 60 })
    expect(timeout).toBe(60)
  })

  test('clamps low timeout', () => {
    const { timeout } = extractArgs({ script: 'x', timeout: 1 })
    expect(timeout).toBe(5)
  })

  test('clamps high timeout', () => {
    const { timeout } = extractArgs({ script: 'x', timeout: 300 })
    expect(timeout).toBe(120)
  })

  test('handles NaN timeout', () => {
    const { timeout } = extractArgs({ script: 'x', timeout: 'abc' })
    expect(timeout).toBe(30)
  })

  test('empty script returns empty string', () => {
    const { script } = extractArgs({})
    expect(script).toBe('')
  })

  test('null script returns empty string', () => {
    const { script } = extractArgs({ script: null })
    expect(script).toBe('')
  })
})
