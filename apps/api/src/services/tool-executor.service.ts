import { prisma } from '../lib/prisma.js'
import type { Prisma } from '@prisma/client'
import type { GroundingMetadata, Tool as GeminiTool } from '@google/generative-ai'
import { embeddingService } from './embedding.service.js'
import { searchService } from './search.service.js'
import { sandboxService } from './sandbox.service.js'
import { ingestionService } from './ingestion.service.js'
import { storageService } from './storage.service.js'
import { cronService } from './cron.service.js'
import { settingsService } from './settings.service.js'
import { browserService } from './browser.service.js'
import type { ToolCall } from '../providers/llm.interface.js'
import type { SSEEmit } from '../lib/sse.js'
import {
  SEARCH_RESULTS_LIMIT,
  ALWAYS_ON_CAPABILITY_SLUGS,
  DELEGATION_ONLY_TOOLS,
} from '../constants.js'
import { toolDiscoveryService } from './tool-discovery.service.js'
import { subAgentService } from './sub-agent.service.js'
import { SUB_AGENT_ROLES } from './sub-agent-roles.js'
import type { SubAgentRole } from './sub-agent.types.js'
import { stripNullBytes, stripNullBytesOrNull } from '../lib/sanitize.js'
import { extractScreenshotBase64 } from '../lib/screenshot.js'
import { htmlToMarkdown, htmlToText } from '../lib/html-to-markdown.js'
import { isPrivateHost } from '../lib/url-safety.js'
import type { SecretInventory } from './secret-redaction.service.js'
import { secretRedactionService } from './secret-redaction.service.js'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

interface ExecutionContext {
  workspaceId: string
  chatSessionId: string
  secretInventory?: SecretInventory
  /** Override browser session key for sub-agent isolation (defaults to chatSessionId) */
  browserSessionId?: string
  /** Pre-loaded capability data to avoid redundant DB lookups during tool execution */
  capability?: {
    slug: string
    skillType: string | null
    toolDefinitions: unknown
  }
  /** SSE emitter for streaming events (needed by sub-agent delegation) */
  emit?: SSEEmit
  /** Pre-loaded capabilities for the workspace (passed to sub-agents to avoid redundant DB queries) */
  capabilities?: Array<{
    slug: string
    toolDefinitions: unknown
    skillType?: string | null
    name: string
    systemPrompt: string
  }>
  /** Capability slugs the user explicitly mentioned (e.g. /browser-automation) — forwarded to sub-agents */
  mentionedSlugs?: string[]
  /** Abort signal to cancel the agent loop */
  signal?: AbortSignal
}

export interface DocumentSource {
  documentId: string
  documentTitle: string
  workspaceId?: string
  chunkId: string
  chunkIndex: number
}

export interface ExecutionResult {
  output: string
  error?: string
  exitCode?: number
  durationMs: number
  sources?: DocumentSource[]
  /** ID of the ToolExecution record created in the database */
  executionId?: string
  /** IDs of sub-agent ToolExecution records (for delegate_task) */
  subAgentExecutionIds?: string[]
}

// ---------------------------------------------------------------------------
// Tool handler type and standalone handler functions
// ---------------------------------------------------------------------------

type ToolHandler = (toolCall: ToolCall, context: ExecutionContext) => Promise<ExecutionResult>

/**
 * Execute document search (the existing RAG pipeline).
 */
async function executeDocumentSearch(
  toolCall: ToolCall,
  context: ExecutionContext,
): Promise<ExecutionResult> {
  const startTime = Date.now()
  const { query, documentIds } = toolCall.arguments as {
    query: string
    documentIds?: string[]
  }

  const queryVector = await embeddingService.embed(query)

  let searchResults = await searchService.search(queryVector, {
    limit: SEARCH_RESULTS_LIMIT,
    workspaceId: context.workspaceId,
    documentIds,
  })

  if (!searchResults.length) {
    searchResults = await searchService.search(queryVector, {
      limit: SEARCH_RESULTS_LIMIT,
      documentIds,
    })
  }

  const chunkIds = searchResults
    .map((r) => (r.payload as Record<string, unknown>)?.chunkId as string)
    .filter(Boolean)

  let chunks = chunkIds.length
    ? await prisma.documentChunk.findMany({
        where: { id: { in: chunkIds } },
        include: { document: { select: { title: true, id: true } } },
      })
    : []

  if (!chunks.length && searchResults.length) {
    const qdrantIds = searchResults.map((r) => r.id as string).filter(Boolean)
    chunks = await prisma.documentChunk.findMany({
      where: { qdrantId: { in: qdrantIds } },
      include: { document: { select: { title: true, id: true } } },
    })
  }

  if (!chunks.length) {
    return {
      output: 'No relevant documents found for this query.',
      durationMs: Date.now() - startTime,
    }
  }

  const output = chunks
    .map((c) => `[Source: ${c.document.title}]\n${c.content}`)
    .join('\n\n---\n\n')

  // Build structured sources for UI display
  const seen = new Set<string>()
  const sources: DocumentSource[] = []
  for (const c of chunks) {
    if (!seen.has(c.document.id)) {
      seen.add(c.document.id)
      sources.push({
        documentId: c.document.id,
        documentTitle: c.document.title,
        workspaceId: context.workspaceId,
        chunkId: c.id,
        chunkIndex: c.chunkIndex,
      })
    }
  }

  return { output, durationMs: Date.now() - startTime, sources }
}

/**
 * Fetch a URL and return its content, converting HTML to Markdown.
 */
async function executeWebFetch(toolCall: ToolCall): Promise<ExecutionResult> {
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
 * Save a document to the agent's knowledge base.
 */
async function executeSaveDocument(
  toolCall: ToolCall,
  context: ExecutionContext,
): Promise<ExecutionResult> {
  const startTime = Date.now()
  const args = toolCall.arguments as Record<string, unknown>
  const title = String(args.title ?? 'Untitled')
  const content = String(args.content ?? '')

  // Get or create the __agent__ folder in the current workspace
  let agentFolder = await prisma.folder.findFirst({
    where: { workspaceId: context.workspaceId, name: '__agent__', parentId: null },
  })
  if (!agentFolder) {
    agentFolder = await prisma.folder.create({
      data: { name: '__agent__', workspaceId: context.workspaceId },
    })
  }

  const doc = await prisma.document.create({
    data: {
      title,
      content,
      type: 'MARKDOWN',
      status: 'PENDING',
      workspaceId: context.workspaceId,
      folderId: agentFolder.id,
    },
  })

  // Trigger ingestion (chunking + embeddings)
  await ingestionService.enqueue(doc.id)

  return {
    output: `Document "${title}" saved successfully (id: ${doc.id}). It will be indexed for search shortly.`,
    durationMs: Date.now() - startTime,
  }
}

/**
 * Generate a downloadable file and return a download URL.
 */
async function executeGenerateFile(
  toolCall: ToolCall,
  context: ExecutionContext,
): Promise<ExecutionResult> {
  const startTime = Date.now()
  const args = toolCall.arguments as Record<string, unknown>
  const filename = String(args.filename ?? 'file.txt')
  const sourcePath = args.sourcePath as string | undefined

  const ext = filename.split('.').pop()?.toLowerCase() ?? 'txt'
  const BINARY_EXTENSIONS = new Set([
    'jpg',
    'jpeg',
    'png',
    'gif',
    'webp',
    'bmp',
    'ico',
    'pdf',
    'zip',
    'tar',
    'gz',
    'mp3',
    'mp4',
    'wav',
    'ogg',
    'woff',
    'woff2',
    'ttf',
    'otf',
  ])
  const isBinary = BINARY_EXTENSIONS.has(ext)

  const mimeTypes: Record<string, string> = {
    csv: 'text/csv',
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    html: 'text/html',
    xml: 'application/xml',
    yaml: 'text/yaml',
    yml: 'text/yaml',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    zip: 'application/zip',
  }

  let buffer: Buffer
  if (sourcePath) {
    // Read file content from sandbox
    if (!context.workspaceId) {
      return {
        output: '',
        error: 'sourcePath requires an active sandbox. Use content parameter instead.',
        durationMs: Date.now() - startTime,
      }
    }
    const userHome = '/workspace'
    // Resolve relative paths to workspace directory
    const resolvedPath = sourcePath.startsWith('/') ? sourcePath : `${userHome}/${sourcePath}`

    if (isBinary) {
      // For binary files, read as base64 to preserve bytes
      let readResult = await sandboxService.execInWorkspace(
        context.workspaceId,
        `base64 -w0 ${JSON.stringify(resolvedPath)}`,
        { timeout: 30 },
      )
      // Fallback: try basename in workspace dir
      if (
        readResult.exitCode !== 0 &&
        resolvedPath !== `${userHome}/${sourcePath.split('/').pop()}`
      ) {
        const fallbackPath = `${userHome}/${sourcePath.split('/').pop()}`
        const fallbackResult = await sandboxService.execInWorkspace(
          context.workspaceId,
          `base64 -w0 ${JSON.stringify(fallbackPath)}`,
          { timeout: 30 },
        )
        if (fallbackResult.exitCode === 0) {
          readResult = fallbackResult
        }
      }
      if (readResult.exitCode !== 0) {
        return {
          output: '',
          error: `Failed to read ${sourcePath}: ${readResult.stderr}. Your working directory is ${userHome}/ — use absolute paths or relative paths from there.`,
          durationMs: Date.now() - startTime,
        }
      }
      buffer = Buffer.from(readResult.stdout.trim(), 'base64')
    } else {
      // For text files, read normally
      let readResult = await sandboxService.execInWorkspace(
        context.workspaceId,
        `cat ${JSON.stringify(resolvedPath)}`,
        { timeout: 10 },
      )
      // Fallback: try basename in workspace dir
      if (
        readResult.exitCode !== 0 &&
        resolvedPath !== `${userHome}/${sourcePath.split('/').pop()}`
      ) {
        const fallbackPath = `${userHome}/${sourcePath.split('/').pop()}`
        const fallbackResult = await sandboxService.execInWorkspace(
          context.workspaceId,
          `cat ${JSON.stringify(fallbackPath)}`,
          { timeout: 10 },
        )
        if (fallbackResult.exitCode === 0) {
          readResult = fallbackResult
        }
      }
      if (readResult.exitCode !== 0) {
        return {
          output: '',
          error: `Failed to read ${sourcePath}: ${readResult.stderr}. Your working directory is ${userHome}/ — use absolute paths or relative paths from there.`,
          durationMs: Date.now() - startTime,
        }
      }
      buffer = Buffer.from(readResult.stdout, 'utf-8')
    }
  } else if (args.content) {
    buffer = Buffer.from(String(args.content), 'utf-8')
  } else {
    return {
      output: '',
      error: 'Either content or sourcePath must be provided',
      durationMs: Date.now() - startTime,
    }
  }

  const key = `generated/${Date.now()}-${filename}`
  await storageService.upload(key, buffer, mimeTypes[ext] ?? 'application/octet-stream')

  const downloadUrl = `/api/files/${key}`

  return {
    output: JSON.stringify({ filename, downloadUrl }),
    durationMs: Date.now() - startTime,
  }
}

/**
 * Resolve a dynamic skill tool name to a shell command.
 * Uses the capability's skillType to determine how to execute.
 */
async function resolveSkillCommand(
  toolName: string,
  args: Record<string, unknown>,
  capabilitySlug: string,
  preloadedCapability?: { skillType: string | null; toolDefinitions: unknown },
): Promise<string> {
  // Use pre-loaded capability data when available to avoid redundant DB queries
  let skillType: string | null = null
  let toolDefinitions: unknown = null

  if (preloadedCapability) {
    skillType = preloadedCapability.skillType
    toolDefinitions = preloadedCapability.toolDefinitions
  } else {
    const { prisma: db } = await import('../lib/prisma.js')
    const capability = await db.capability.findUnique({
      where: { slug: capabilitySlug },
    })
    skillType = capability?.skillType ?? null
    toolDefinitions = capability?.toolDefinitions ?? null
  }

  if (!skillType) return ''

  // Look up the tool definition to check for prefix/script
  const toolDefs = toolDefinitions as Array<{
    name: string
    prefix?: string
    script?: string
    parameters?: { required?: string[] }
  }>
  const toolDef = toolDefs?.find((t) => t.name === toolName)
  const prefix = toolDef?.prefix ?? ''

  // If the tool has a script, write it to a file and execute with args as CLI arguments
  if (toolDef?.script) {
    const ext = skillType === 'python' ? 'py' : skillType === 'js' ? 'mjs' : 'sh'
    const runtime = skillType === 'python' ? 'python3' : skillType === 'js' ? 'node' : 'bash'
    const scriptPath = `/tmp/_skill_${toolName}.${ext}`

    // Collect tool arguments as positional CLI args in a stable order (required first)
    const paramDef = toolDef.parameters as { required?: string[] } | undefined
    const requiredKeys = paramDef?.required ?? []
    const orderedKeys = [
      ...requiredKeys,
      ...Object.keys(args).filter((k) => !requiredKeys.includes(k) && k !== 'timeout'),
    ]
    const cliArgs = orderedKeys
      .map((k) => args[k])
      .filter((v) => v !== undefined && v !== null)
      .map((v) => JSON.stringify(String(v)))
      .join(' ')

    const writeCmd = `cat > ${scriptPath} << 'SKILL_SCRIPT_EOF'\n${toolDef.script}\nSKILL_SCRIPT_EOF`
    return `${writeCmd}\n${runtime} ${scriptPath} ${cliArgs}`
  }

  // Determine command based on skill type and tool arguments
  switch (skillType) {
    case 'bash': {
      const raw = (args.command ?? args.code ?? '') as string
      return prefix ? `${prefix} ${raw}` : raw
    }
    case 'python': {
      const code = (args.code ?? args.command ?? '') as string
      const pyB64 = Buffer.from(code).toString('base64')
      return `echo '${pyB64}' | base64 -d | python3`
    }
    case 'js': {
      const code = (args.code ?? args.command ?? '') as string
      const jsB64 = Buffer.from(code).toString('base64')
      return `echo '${jsB64}' | base64 -d | node`
    }
    default:
      return ''
  }
}

/**
 * Execute a command in the sandbox.
 * Handles both hardcoded tools (file-ops) and dynamic skill tools.
 */
async function executeSandboxCommand(
  toolCall: ToolCall,
  capabilitySlug: string,
  context: ExecutionContext,
): Promise<ExecutionResult> {
  const startTime = Date.now()

  if (!context.workspaceId) {
    return {
      output: '',
      error: 'No workspace context available. Sandbox capabilities require a workspace.',
      durationMs: Date.now() - startTime,
    }
  }

  const args = toolCall.arguments as Record<string, unknown>
  let command: string

  switch (toolCall.name) {
    // Well-known runtime tools
    case 'run_bash':
      command = args.command as string
      break
    case 'run_python': {
      const pyB64 = Buffer.from(args.code as string).toString('base64')
      command = `echo '${pyB64}' | base64 -d | python3`
      break
    }
    case 'run_js': {
      const jsB64 = Buffer.from(args.code as string).toString('base64')
      command = `echo '${jsB64}' | base64 -d | node`
      break
    }

    default: {
      // Dynamic skill tool resolution:
      // Use pre-loaded capability data when available to avoid redundant DB queries
      command = await resolveSkillCommand(toolCall.name, args, capabilitySlug, context.capability)
      if (!command) {
        return {
          output: '',
          error: `Unsupported sandbox tool: ${toolCall.name}`,
          durationMs: Date.now() - startTime,
        }
      }
      break
    }
  }

  const userHome = '/workspace'
  const execOptions = {
    timeout: (args.timeout as number) ?? 30,
    workingDir: (args.workingDir as string) ?? userHome,
  }

  const result = await sandboxService.execInWorkspace(
    context.workspaceId,
    command,
    execOptions,
  )

  // Sanitize output to strip null bytes that break PostgreSQL and JSON
  const stdout = result.stdout ? stripNullBytes(result.stdout) : ''
  const stderr = result.stderr ? stripNullBytes(result.stderr) : ''

  const output = [
    stdout ? `stdout:\n${stdout}` : '',
    stderr ? `stderr:\n${stderr}` : '',
    `exit code: ${result.exitCode}`,
  ]
    .filter(Boolean)
    .join('\n\n')

  return {
    output,
    error:
      result.exitCode !== 0
        ? stderr || `Command failed with exit code ${result.exitCode}`
        : undefined,
    exitCode: result.exitCode,
    durationMs: Date.now() - startTime,
  }
}

/**
 * Create a cron job via agent tool call.
 */
async function executeCreateCron(
  toolCall: ToolCall,
  context: ExecutionContext,
): Promise<ExecutionResult> {
  const startTime = Date.now()
  const args = toolCall.arguments as Record<string, unknown>

  const job = await cronService.create({
    name: String(args.name ?? 'Unnamed cron'),
    schedule: String(args.schedule ?? '*/30 * * * *'),
    prompt: String(args.prompt ?? ''),
    type: 'agent',
    workspaceId: context.workspaceId,
    sessionId: context.chatSessionId,
  })

  return {
    output: `Cron job "${job.name}" created successfully (id: ${job.id}, schedule: ${job.schedule}). It will run in this conversation on the specified schedule.`,
    durationMs: Date.now() - startTime,
  }
}

/**
 * List all cron jobs.
 */
async function executeListCrons(): Promise<ExecutionResult> {
  const startTime = Date.now()
  const jobs = await cronService.list()

  if (!jobs.length) {
    return { output: 'No cron jobs configured.', durationMs: Date.now() - startTime }
  }

  const output = jobs
    .map(
      (j) =>
        `- **${j.name}** (id: ${j.id})\n  Schedule: ${j.schedule} | Type: ${j.type} | Enabled: ${j.enabled}\n  Last run: ${j.lastRunAt?.toISOString() ?? 'never'} (${j.lastRunStatus ?? 'n/a'})`,
    )
    .join('\n\n')

  return { output, durationMs: Date.now() - startTime }
}

/**
 * Delete a cron job by ID.
 */
async function executeDeleteCron(toolCall: ToolCall): Promise<ExecutionResult> {
  const startTime = Date.now()
  const args = toolCall.arguments as Record<string, unknown>
  const id = String(args.id ?? '')

  try {
    await cronService.delete(id)
    return {
      output: `Cron job ${id} deleted successfully.`,
      durationMs: Date.now() - startTime,
    }
  } catch (err) {
    return {
      output: '',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    }
  }
}

/**
 * Web search using Gemini's Google Search grounding.
 */
async function executeWebSearch(toolCall: ToolCall): Promise<ExecutionResult> {
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

/**
 * Execute a Playwright script via BrowserGrid.
 */
async function executeBrowserScript(
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
        const saveResult = await sandboxService.execInWorkspace(
          context.workspaceId,
          `mkdir -p ${JSON.stringify(path.posix.dirname(resolvedPath))} && printf '%s' ${JSON.stringify(screenshotB64)} | base64 -d | tee ${JSON.stringify(resolvedPath)} >/dev/null && chmod 666 ${JSON.stringify(resolvedPath)}`,
          { timeout: 15 },
        )
        if (saveResult.exitCode !== 0) {
          return {
            output: '',
            error: `Failed to save screenshot to ${resolvedPath}: ${saveResult.stderr || 'unknown error'}`,
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

/**
 * Discover tools via semantic search or list all available.
 */
async function executeDiscoverTools(
  toolCall: ToolCall,
  context: ExecutionContext,
): Promise<ExecutionResult> {
  const startTime = Date.now()
  const args = toolCall.arguments as { query: string; list_all?: boolean }

  // Get enabled capability slugs for this workspace, excluding always-on
  const enabledCaps = await prisma.workspaceCapability.findMany({
    where: { workspaceId: context.workspaceId, enabled: true },
    include: { capability: { select: { slug: true } } },
  })
  const enabledSlugs = enabledCaps
    .map((wc) => wc.capability.slug)
    .filter((slug) => !ALWAYS_ON_CAPABILITY_SLUGS.includes(slug))

  if (args.list_all) {
    const listing = await toolDiscoveryService.listAvailable(enabledSlugs)
    return {
      output: JSON.stringify({
        type: 'tool_listing',
        available: listing,
      }),
      durationMs: Date.now() - startTime,
    }
  }

  const discovered = await toolDiscoveryService.search(args.query, enabledSlugs)

  if (!discovered.length) {
    return {
      output: JSON.stringify({
        type: 'discovery_result',
        discovered: [],
        hint: 'No matching tools found. Try calling discover_tools with list_all: true to see all available capabilities.',
      }),
      durationMs: Date.now() - startTime,
    }
  }

  // Mark delegation-only tools so the LLM knows to use delegate_task
  const annotatedDiscovered = discovered.map((cap) => ({
    slug: cap.slug,
    name: cap.name,
    tools: cap.tools.map((tool) =>
      DELEGATION_ONLY_TOOLS.has(tool.name)
        ? { ...tool, description: `[DELEGATION-ONLY — use delegate_task] ${tool.description}` }
        : tool,
    ),
    instructions: cap.instructions,
  }))

  return {
    output: JSON.stringify({
      type: 'discovery_result',
      discovered: annotatedDiscovered,
    }),
    durationMs: Date.now() - startTime,
  }
}

/**
 * Delegate a task to a sub-agent.
 */
async function executeDelegateTask(
  toolCall: ToolCall,
  context: ExecutionContext,
): Promise<ExecutionResult> {
  const startTime = Date.now()
  const args = toolCall.arguments as { role: string; task: string; context?: string }

  if (!args.role || !args.task) {
    return {
      output: '',
      error: 'Both role and task are required',
      durationMs: Date.now() - startTime,
    }
  }

  if (!(args.role in SUB_AGENT_ROLES)) {
    const validRoles = Object.keys(SUB_AGENT_ROLES).join(', ')
    return {
      output: '',
      error: `Invalid role: "${args.role}". Must be one of: ${validRoles}`,
      durationMs: Date.now() - startTime,
    }
  }

  const inventory =
    context.secretInventory ??
    (await secretRedactionService.buildSecretInventory(context.workspaceId))

  // Each sub-agent gets its own browser session to avoid page collisions during parallel execution
  const browserSessionId = `sub-${toolCall.id}`

  // Resolve user-mentioned capability slugs to tool names for sub-agent preference
  let preferredTools: string[] | undefined
  if (context.mentionedSlugs?.length && context.capabilities) {
    const mentionedSet = new Set(context.mentionedSlugs)
    preferredTools = context.capabilities
      .filter((cap) => mentionedSet.has(cap.slug))
      .flatMap((cap) => {
        const defs = cap.toolDefinitions as Array<{ name: string }>
        return defs?.map((t) => t.name) ?? []
      })
    if (!preferredTools.length) preferredTools = undefined
  }

  const subResult = await subAgentService.runSubAgent(
    {
      role: args.role as SubAgentRole,
      task: args.task,
      context: args.context,
    },
    {
      workspaceId: context.workspaceId,
      sessionId: context.chatSessionId,
      secretInventory: inventory,
      emit: context.emit,
      capabilities: context.capabilities,
      subAgentId: toolCall.id,
      browserSessionId,
      preferredTools,
      signal: context.signal,
    },
  )

  // Cleanup: close sub-agent's isolated browser session (if one was created)
  await browserService.closeSession(browserSessionId).catch(() => {})

  // Persist sub-agent tool executions to DB (batched in a transaction)
  let subAgentExecutionIds: string[] = []
  if (subResult.toolExecutions.length) {
    const executions = await prisma.$transaction(
      subResult.toolExecutions.map((te) =>
        prisma.toolExecution.create({
          data: {
            capabilitySlug: te.capabilitySlug,
            toolName: te.toolName,
            input: te.input as Prisma.InputJsonValue,
            output: te.output ?? null,
            error: te.error ?? null,
            durationMs: te.durationMs,
            status: te.error ? 'failed' : 'completed',
          },
        }),
      ),
    )
    subAgentExecutionIds = executions.map((e) => e.id)
  }

  const output = [
    `## Sub-Agent Result (${subResult.role})`,
    '',
    subResult.result,
    '',
    `---`,
    `Iterations: ${subResult.iterationsUsed} | Tools used: ${subResult.toolExecutions.length} | Success: ${subResult.success}`,
    subResult.tokenUsage
      ? `Tokens: ${subResult.tokenUsage.inputTokens} in / ${subResult.tokenUsage.outputTokens} out`
      : '',
  ]
    .filter(Boolean)
    .join('\n')

  return {
    output,
    error: subResult.success ? undefined : 'Sub-agent did not complete successfully',
    durationMs: Date.now() - startTime,
    subAgentExecutionIds,
  }
}

// ---------------------------------------------------------------------------
// Read File — optimised file reader with line numbers, pagination & guards
// ---------------------------------------------------------------------------

async function executeReadFile(
  toolCall: ToolCall,
  context: ExecutionContext,
): Promise<ExecutionResult> {
  const startTime = Date.now()
  const fail = (error: string): ExecutionResult => ({
    output: '',
    error,
    durationMs: Date.now() - startTime,
  })

  // 1. Extract & validate parameters
  const args = toolCall.arguments as Record<string, unknown>
  const filePath = String(args.file_path ?? '').trim()
  if (!filePath) return fail('file_path is required.')

  const offset = Math.max(1, Math.floor(Number(args.offset) || 1))
  const limit = Math.min(2000, Math.max(1, Math.floor(Number(args.limit) || 2000)))
  const endLine = offset + limit - 1

  // 2. Require active sandbox
  if (!context.workspaceId) {
    return fail('read_file requires an active sandbox session.')
  }

  const userHome = '/workspace'
  const resolvedPath = filePath.startsWith('/') ? filePath : `${userHome}/${filePath}`

  // 3. Build shell script that runs inside the sandbox
  //    Uses sentinel prefixes so we can parse the result deterministically.
  const script = [
    'set -e',
    `FILE=${JSON.stringify(resolvedPath)}`,
    // existence check
    'if [ ! -e "$FILE" ]; then echo "@@NOT_FOUND@@"; exit 0; fi',
    // directory check
    'if [ -d "$FILE" ]; then echo "@@IS_DIRECTORY@@"; exit 0; fi',
    // binary check (file --mime-encoding returns "binary" for non-text)
    'ENCODING=$(file --mime-encoding -b "$FILE" 2>/dev/null || echo "unknown")',
    'if echo "$ENCODING" | grep -qi "binary"; then echo "@@BINARY@@"; exit 0; fi',
    // empty check
    'if [ ! -s "$FILE" ]; then echo "@@EMPTY@@"; exit 0; fi',
    // total line count
    'TOTAL=$(wc -l < "$FILE")',
    'echo "@@TOTAL:$TOTAL@@"',
    // read with awk: line numbers (1-based), range, truncation at 2000 chars
    `awk 'NR >= ${offset} && NR <= ${endLine} {`,
    '  line = $0',
    '  if (length(line) > 2000) line = substr(line, 1, 2000) "... [truncated]"',
    '  printf "%6d\\t%s\\n", NR, line',
    `}' "$FILE"`,
  ].join('\n')

  // 4. Execute inside the sandbox
  let result = await sandboxService.execInWorkspace(
    context.workspaceId,
    script,
    { timeout: 15 },
  )

  // 5. Fallback: try basename in workspace dir (same pattern as executeGenerateFile)
  if (
    result.exitCode !== 0 &&
    resolvedPath !== `${userHome}/${filePath.split('/').pop()}`
  ) {
    const fallbackPath = `${userHome}/${filePath.split('/').pop()}`
    const fallbackScript = script.replace(
      `FILE=${JSON.stringify(resolvedPath)}`,
      `FILE=${JSON.stringify(fallbackPath)}`,
    )
    const fallbackResult = await sandboxService.execInWorkspace(
      context.workspaceId,
      fallbackScript,
      { timeout: 15 },
    )
    if (fallbackResult.exitCode === 0) {
      result = fallbackResult
    }
  }

  if (result.exitCode !== 0) {
    return fail(
      `Failed to read file: ${result.stderr || 'unknown error'}. Your working directory is ${userHome}/ — use absolute paths or relative paths from there.`,
    )
  }

  const stdout = result.stdout

  // 6. Handle sentinel values
  if (stdout.startsWith('@@NOT_FOUND@@')) {
    return fail(`File not found: ${filePath}`)
  }
  if (stdout.startsWith('@@IS_DIRECTORY@@')) {
    return fail(
      `${filePath} is a directory, not a file. Use bash with \`ls\` to list directory contents.`,
    )
  }
  if (stdout.startsWith('@@BINARY@@')) {
    return fail(`${filePath} is a binary file and cannot be displayed as text.`)
  }
  if (stdout.startsWith('@@EMPTY@@')) {
    return {
      output: `${filePath} is empty (0 lines).`,
      durationMs: Date.now() - startTime,
    }
  }

  // 7. Parse total lines and content
  const totalMatch = stdout.match(/^@@TOTAL:(\d+)@@$/m)
  const totalLines = totalMatch ? parseInt(totalMatch[1], 10) : 0
  const content = stdout.replace(/^@@TOTAL:\d+@@\n?/, '')

  // 8. Size guard — cap at 20 KB to prevent context overflow
  const MAX_OUTPUT_BYTES = 20_000
  let finalContent = content
  if (finalContent.length > MAX_OUTPUT_BYTES) {
    finalContent = finalContent.slice(0, MAX_OUTPUT_BYTES) + '\n... [output truncated at 20 KB]'
  }

  // 9. Build informative header
  const actualEnd = Math.min(endLine, totalLines)
  let header = `[File: ${filePath}] [Lines: ${offset}-${actualEnd} of ${totalLines}]`
  if (endLine < totalLines) {
    header += ` (use offset=${endLine + 1} to see more)`
  }

  return {
    output: `${header}\n${finalContent}`,
    durationMs: Date.now() - startTime,
  }
}

// ---------------------------------------------------------------------------
// Tool handler registry — maps tool names to their handler functions
// ---------------------------------------------------------------------------

const toolHandlerRegistry = new Map<string, ToolHandler>([
  ['search_documents', executeDocumentSearch],
  ['save_document', executeSaveDocument],
  ['generate_file', executeGenerateFile],
  ['read_file', executeReadFile],
  ['create_cron', executeCreateCron],
  ['list_crons', (_toolCall, _context) => executeListCrons()],
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
      console.error(`[ToolExecutor] Tool "${toolCall.name}" threw:`, error)

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
        console.error(
          `[ToolExecutor] Failed to record execution error for ${toolCall.name}:`,
          error,
        )
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
