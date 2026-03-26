import type { ToolCall } from '../../providers/llm.interface.js'
import type { GroundingMetadata, Tool as GeminiTool } from '@google/generative-ai'
import { settingsService } from '../settings.service.js'
import { htmlToMarkdown, htmlToText } from '../../lib/html-to-markdown.js'
import { isPrivateHost } from '../../lib/url-safety.js'
import type { ExecutionResult } from './handler-utils.js'

/**
 * Fetch a URL and return its content, converting HTML to Markdown.
 */
export async function executeWebFetch(toolCall: ToolCall): Promise<ExecutionResult> {
  const startTime = Date.now()
  const fail = (error: string): ExecutionResult => ({
    output: '',
    error,
    durationMs: Date.now() - startTime,
  })

  const args = toolCall.arguments as Record<string, unknown>
  const url = String(args.url ?? '')
  const formatRaw = String(args.format ?? 'markdown').toLowerCase()
  if (!['markdown', 'text', 'html'].includes(formatRaw)) {
    return fail(`Invalid format "${formatRaw}" — must be markdown, text, or html`)
  }
  const format = formatRaw as 'markdown' | 'text' | 'html'
  const method = String(args.method ?? 'GET').toUpperCase()
  const customHeaders = (args.headers as Record<string, string>) ?? {}
  const body = args.body as string | undefined
  const maxBytes = Math.min((Number(args.maxKb) || 100) * 1024, 5 * 1024 * 1024)

  // Validate URL
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return fail('Invalid URL')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return fail('Only http/https URLs are supported')
  }

  // SSRF protection
  if (isPrivateHost(parsed.hostname)) {
    return fail('Requests to private/internal addresses are blocked')
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)

    const res = await fetch(url, {
      method,
      headers: {
        'User-Agent': 'ClawBuddy/1.0',
        Accept: 'text/html,application/xhtml+xml,*/*',
        ...customHeaders,
      },
      body: ['POST', 'PUT', 'PATCH'].includes(method) ? body : undefined,
      signal: controller.signal,
      redirect: 'follow',
    })
    clearTimeout(timer)

    // Read body up to maxBytes (streaming)
    const reader = res.body?.getReader()
    const chunks: Uint8Array[] = []
    let bytesRead = 0
    let truncated = false
    if (reader) {
      while (bytesRead < maxBytes) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        bytesRead += value.byteLength
      }
      if (bytesRead >= maxBytes) truncated = true
      reader.cancel()
    }
    const rawText = new TextDecoder().decode(Buffer.concat(chunks))

    // Convert based on content-type and requested format
    const contentType = res.headers.get('content-type') ?? ''
    const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml')
    let content: string

    if (isHtml && format === 'markdown') {
      content = htmlToMarkdown(rawText)
    } else if (isHtml && format === 'text') {
      content = htmlToText(rawText)
    } else {
      content = rawText
    }

    if (truncated) content += `\n\n[... truncated at ${Math.round(maxBytes / 1024)} KB]`

    const output = JSON.stringify({
      status: res.status,
      statusText: res.statusText,
      contentType,
      body: content,
    })

    return { output, durationMs: Date.now() - startTime }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return fail(`Fetch failed: ${msg}`)
  }
}

/**
 * Web search using Gemini's Google Search grounding.
 */
export async function executeWebSearch(toolCall: ToolCall): Promise<ExecutionResult> {
  const startTime = Date.now()
  const args = toolCall.arguments as Record<string, unknown>
  const query = String(args.query ?? '')

  if (!query.trim()) {
    return { output: '', error: 'Search query is required', durationMs: Date.now() - startTime }
  }

  const apiKey = await settingsService.getApiKey('gemini')
  if (!apiKey) {
    return {
      output: '',
      error: 'Web search requires a Gemini API key. Please configure it in Settings.',
      durationMs: Date.now() - startTime,
    }
  }

  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai')
    const client = new GoogleGenerativeAI(apiKey)

    const model = client.getGenerativeModel({
      model: 'gemini-2.5-flash',
      tools: [{ googleSearch: {} } as unknown as GeminiTool],
    })

    const result = await model.generateContent(query)
    const response = result.response
    const text = response.text() ?? ''

    // Extract grounding metadata if available
    const candidate = response.candidates?.[0]
    const groundingMeta: GroundingMetadata | undefined = candidate?.groundingMetadata
    let sources = ''
    if (groundingMeta?.groundingChunks?.length) {
      const chunks = groundingMeta.groundingChunks as Array<{
        web?: { uri: string; title: string }
      }>
      sources =
        '\n\n**Sources:**\n' +
        chunks
          .filter((c) => c.web)
          .map((c) => `- [${c.web!.title}](${c.web!.uri})`)
          .join('\n')
    }

    return {
      output: text + sources,
      durationMs: Date.now() - startTime,
    }
  } catch (err) {
    return {
      output: '',
      error: `Web search failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - startTime,
    }
  }
}
