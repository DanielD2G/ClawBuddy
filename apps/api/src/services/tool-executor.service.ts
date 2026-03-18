import { prisma } from '../lib/prisma.js'
import type { Prisma } from '@prisma/client'
import { embeddingService } from './embedding.service.js'
import { searchService } from './search.service.js'
import { sandboxService } from './sandbox.service.js'
import { ingestionService } from './ingestion.service.js'
import { storageService } from './storage.service.js'
import { cronService } from './cron.service.js'
import { settingsService } from './settings.service.js'
import { browserService } from './browser.service.js'
import type { ToolCall } from '../providers/llm.interface.js'
import { SEARCH_RESULTS_LIMIT, ALWAYS_ON_CAPABILITY_SLUGS } from '../constants.js'
import { toolDiscoveryService } from './tool-discovery.service.js'
import { stripNullBytes, stripNullBytesOrNull } from '../lib/sanitize.js'
import { extractScreenshotBase64 } from '../lib/screenshot.js'
import type { SecretInventory } from './secret-redaction.service.js'
import { secretRedactionService } from './secret-redaction.service.js'

interface ExecutionContext {
  workspaceId: string
  chatSessionId: string
  linuxUser: string
  secretInventory?: SecretInventory
  /** Pre-loaded capability data to avoid redundant DB lookups during tool execution */
  capability?: {
    slug: string
    skillType: string | null
    toolDefinitions: unknown
  }
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
}

/**
 * Tools that have custom (non-sandbox) execution logic.
 * Everything else is routed to the sandbox.
 */
export const NON_SANDBOX_TOOLS = new Set([
  'search_documents',
  'save_document',
  'generate_file',
  'create_cron',
  'list_crons',
  'delete_cron',
  'web_search',
  'run_browser_script',
  'discover_tools',
])

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
    const inventory = context.secretInventory
      ?? await secretRedactionService.buildSecretInventory(context.workspaceId)
    const publicInput = secretRedactionService.redactForPublicStorage(
      toolCall.arguments as Record<string, unknown>,
      inventory,
    )

    try {
      let result: ExecutionResult

      if (toolCall.name === 'search_documents') {
        result = await this.executeDocumentSearch(toolCall, context)
      } else if (toolCall.name === 'save_document') {
        result = await this.executeSaveDocument(toolCall, context)
      } else if (toolCall.name === 'generate_file') {
        result = await this.executeGenerateFile(toolCall, context)
      } else if (toolCall.name === 'create_cron') {
        result = await this.executeCreateCron(toolCall, context)
      } else if (toolCall.name === 'list_crons') {
        result = await this.executeListCrons()
      } else if (toolCall.name === 'delete_cron') {
        result = await this.executeDeleteCron(toolCall)
      } else if (toolCall.name === 'web_search') {
        result = await this.executeWebSearch(toolCall)
      } else if (toolCall.name === 'run_browser_script') {
        result = await this.executeBrowserScript(toolCall, context)
      } else if (toolCall.name === 'discover_tools') {
        result = await this.executeDiscoverTools(toolCall, context)
      } else {
        // All other tools are routed to the sandbox
        result = await this.executeSandboxCommand(toolCall, capabilitySlug, context)
      }

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
        ? secretRedactionService.redactSerializedText(result.output, inventory, { skipKeys: ['screenshot'] })
        : ''
      const publicDbOutput = outputForDb
        ? secretRedactionService.redactSerializedText(outputForDb, inventory, { skipKeys: ['screenshot'] })
        : null
      const publicError = result.error
        ? secretRedactionService.redactSerializedText(result.error, inventory, { skipKeys: ['screenshot'] })
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
        console.error(`[ToolExecutor] Failed to record execution error for ${toolCall.name}:`, error)
      }

      return { output: '', error, durationMs, executionId }
    }
  },

  /**
   * Execute document search (the existing RAG pipeline).
   */
  async executeDocumentSearch(
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
  },

  /**
   * Execute a command in the sandbox.
   * Handles both hardcoded tools (file-ops) and dynamic skill tools.
   */
  async executeSandboxCommand(
    toolCall: ToolCall,
    capabilitySlug: string,
    context: ExecutionContext,
  ): Promise<ExecutionResult> {
    const startTime = Date.now()

    if (!context.workspaceId || !context.linuxUser) {
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
        command = await this.resolveSkillCommand(toolCall.name, args, capabilitySlug, context.capability)
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

    const userHome = context.linuxUser ? `/workspace/users/${context.linuxUser}` : '/workspace'
    const execOptions = {
      timeout: (args.timeout as number) ?? 30,
      workingDir: (args.workingDir as string) ?? userHome,
    }

    const result = await sandboxService.execInWorkspace(
      context.workspaceId,
      command,
      context.linuxUser,
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
      error: result.exitCode !== 0 ? stderr || `Command failed with exit code ${result.exitCode}` : undefined,
      exitCode: result.exitCode,
      durationMs: Date.now() - startTime,
    }
  },

  /**
   * Save a document to the agent's knowledge base.
   */
  async executeSaveDocument(toolCall: ToolCall, context: ExecutionContext): Promise<ExecutionResult> {
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
  },

  /**
   * Generate a downloadable file and return a download URL.
   */
  async executeGenerateFile(toolCall: ToolCall, context: ExecutionContext): Promise<ExecutionResult> {
    const startTime = Date.now()
    const args = toolCall.arguments as Record<string, unknown>
    const filename = String(args.filename ?? 'file.txt')
    const sourcePath = args.sourcePath as string | undefined

    let content: string
    if (sourcePath) {
      // Read file content from sandbox
      if (!context.linuxUser) {
        return { output: '', error: 'sourcePath requires an active sandbox. Use content parameter instead.', durationMs: Date.now() - startTime }
      }
      const userHome = `/workspace/users/${context.linuxUser}`
      // Resolve relative paths to user's home directory
      const resolvedPath = sourcePath.startsWith('/') ? sourcePath : `${userHome}/${sourcePath}`
      let readResult = await sandboxService.execInWorkspace(
        context.workspaceId,
        `cat ${JSON.stringify(resolvedPath)}`,
        context.linuxUser,
        { timeout: 10 },
      )
      // Fallback: if absolute path failed, try the basename in user's home dir
      if (readResult.exitCode !== 0 && resolvedPath !== `${userHome}/${sourcePath.split('/').pop()}`) {
        const fallbackPath = `${userHome}/${sourcePath.split('/').pop()}`
        const fallbackResult = await sandboxService.execInWorkspace(
          context.workspaceId,
          `cat ${JSON.stringify(fallbackPath)}`,
          context.linuxUser,
          { timeout: 10 },
        )
        if (fallbackResult.exitCode === 0) {
          readResult = fallbackResult
        }
      }
      if (readResult.exitCode !== 0) {
        return { output: '', error: `Failed to read ${sourcePath}: ${readResult.stderr}. Your working directory is ${userHome}/ — use absolute paths or relative paths from there.`, durationMs: Date.now() - startTime }
      }
      content = readResult.stdout
    } else if (args.content) {
      content = String(args.content)
    } else {
      return { output: '', error: 'Either content or sourcePath must be provided', durationMs: Date.now() - startTime }
    }

    const key = `generated/${Date.now()}-${filename}`
    const ext = filename.split('.').pop()?.toLowerCase() ?? 'txt'
    const mimeTypes: Record<string, string> = {
      csv: 'text/csv', md: 'text/markdown', txt: 'text/plain',
      json: 'application/json', html: 'text/html', xml: 'application/xml',
      yaml: 'text/yaml', yml: 'text/yaml',
    }
    await storageService.upload(key, Buffer.from(content, 'utf-8'), mimeTypes[ext] ?? 'text/plain')

    const downloadUrl = `/api/files/${key}`

    return {
      output: JSON.stringify({ filename, downloadUrl }),
      durationMs: Date.now() - startTime,
    }
  },

  /**
   * Resolve a dynamic skill tool name to a shell command.
   * Uses the capability's skillType to determine how to execute.
   */
  async resolveSkillCommand(
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
  },

  /**
   * Create a cron job via agent tool call.
   */
  async executeCreateCron(
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
  },

  /**
   * List all cron jobs.
   */
  async executeListCrons(): Promise<ExecutionResult> {
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
  },

  /**
   * Delete a cron job by ID.
   */
  async executeDeleteCron(toolCall: ToolCall): Promise<ExecutionResult> {
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
  },

  /**
   * Web search using Gemini's Google Search grounding.
   */
  async executeWebSearch(toolCall: ToolCall): Promise<ExecutionResult> {
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
        tools: [{ googleSearch: {} } as any],
      })

      const result = await model.generateContent(query)
      const response = result.response
      const text = response.text() ?? ''

      // Extract grounding metadata if available
      const candidate = response.candidates?.[0]
      const groundingMeta = (candidate as any)?.groundingMetadata
      let sources = ''
      if (groundingMeta?.groundingChunks?.length) {
        const chunks = groundingMeta.groundingChunks as Array<{ web?: { uri: string; title: string } }>
        sources = '\n\n**Sources:**\n' + chunks
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
  },

  /**
   * Execute a Playwright script via BrowserGrid.
   */
  async executeBrowserScript(
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

    const result = await browserService.executeScript(context.chatSessionId, script, timeout)

    if (result.success) {
      return {
        output: result.result ?? 'Script completed.',
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
  },

  /**
   * Discover tools via semantic search or list all available.
   */
  async executeDiscoverTools(
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

    return {
      output: JSON.stringify({
        type: 'discovery_result',
        discovered: discovered.map((cap) => ({
          slug: cap.slug,
          name: cap.name,
          tools: cap.tools,
          instructions: cap.instructions,
        })),
      }),
      durationMs: Date.now() - startTime,
    }
  },

  /**
   * Check if any tool in a list requires a sandbox.
   */
  needsSandbox(toolNames: string[]): boolean {
    return toolNames.some((name) => !NON_SANDBOX_TOOLS.has(name))
  },
}
