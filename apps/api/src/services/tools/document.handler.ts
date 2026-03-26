import { prisma } from '../../lib/prisma.js'
import type { ToolCall } from '../../providers/llm.interface.js'
import { embeddingService } from '../embedding.service.js'
import { searchService } from '../search.service.js'
import { sandboxService } from '../sandbox.service.js'
import { ingestionService } from '../ingestion.service.js'
import { storageService } from '../storage.service.js'
import { SEARCH_RESULTS_LIMIT } from '../../constants.js'
import type { ExecutionContext, ExecutionResult, DocumentSource } from './handler-utils.js'
import { BINARY_EXTENSIONS, MIME_TYPES } from './handler-utils.js'

/**
 * Execute document search (the existing RAG pipeline).
 */
export async function executeDocumentSearch(
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

  let chunks: Array<{
    id: string
    content: string
    chunkIndex: number
    document: { title: string; id: string }
  }> = chunkIds.length
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
 * Save a document to the agent's knowledge base.
 */
export async function executeSaveDocument(
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
export async function executeGenerateFile(
  toolCall: ToolCall,
  context: ExecutionContext,
): Promise<ExecutionResult> {
  const startTime = Date.now()
  const args = toolCall.arguments as Record<string, unknown>
  const filename = String(args.filename ?? 'file.txt')
  const sourcePath = args.sourcePath as string | undefined

  const ext = filename.split('.').pop()?.toLowerCase() ?? 'txt'
  const isBinary = BINARY_EXTENSIONS.has(ext)

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
      // For binary files, use Docker getArchive to bypass stdout size limits
      try {
        buffer = await sandboxService.readFileFromContainer(context.workspaceId, resolvedPath)
      } catch {
        // Fallback: try basename in workspace dir
        if (resolvedPath !== `${userHome}/${sourcePath.split('/').pop()}`) {
          try {
            const fallbackPath = `${userHome}/${sourcePath.split('/').pop()}`
            buffer = await sandboxService.readFileFromContainer(context.workspaceId, fallbackPath)
          } catch (fallbackErr) {
            return {
              output: '',
              error: `Failed to read ${sourcePath}: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}. Your working directory is ${userHome}/ — use absolute paths or relative paths from there.`,
              durationMs: Date.now() - startTime,
            }
          }
        } else {
          return {
            output: '',
            error: `Failed to read ${sourcePath}. Your working directory is ${userHome}/ — use absolute paths or relative paths from there.`,
            durationMs: Date.now() - startTime,
          }
        }
      }
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
  await storageService.upload(key, buffer, MIME_TYPES[ext] ?? 'application/octet-stream')

  const downloadUrl = `/api/files/${key}`

  return {
    output: JSON.stringify({ filename, downloadUrl }),
    durationMs: Date.now() - startTime,
  }
}

/**
 * Read a file from the sandbox with line numbers, pagination & guards.
 */
export async function executeReadFile(
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
  let result = await sandboxService.execInWorkspace(context.workspaceId, script, { timeout: 15 })

  // 5. Fallback: try basename in workspace dir (same pattern as executeGenerateFile)
  if (result.exitCode !== 0 && resolvedPath !== `${userHome}/${filePath.split('/').pop()}`) {
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
