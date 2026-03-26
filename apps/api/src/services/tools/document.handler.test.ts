import { describe, expect, test, vi, beforeEach } from 'vitest'
import { createMockPrisma, type MockPrisma } from '@test/factories/prisma'

// ── Mocks ───────────────────────────────────────────────────────────────

let mockPrisma: MockPrisma

vi.mock('../../lib/prisma.js', () => ({
  get prisma() {
    return mockPrisma
  },
}))

vi.mock('../embedding.service.js', () => ({
  embeddingService: {
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  },
}))

vi.mock('../search.service.js', () => ({
  searchService: {
    search: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('../sandbox.service.js', () => ({
  sandboxService: {
    execInWorkspace: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    readFileFromContainer: vi.fn().mockResolvedValue(Buffer.from('')),
  },
}))

vi.mock('../ingestion.service.js', () => ({
  ingestionService: {
    enqueue: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../storage.service.js', () => ({
  storageService: {
    upload: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../../constants.js', () => ({
  SEARCH_RESULTS_LIMIT: 5,
}))

import {
  executeDocumentSearch,
  executeSaveDocument,
  executeGenerateFile,
  executeReadFile,
} from './document.handler.js'
import { embeddingService } from '../embedding.service.js'
import { searchService } from '../search.service.js'
import { sandboxService } from '../sandbox.service.js'
import { ingestionService } from '../ingestion.service.js'
import { storageService } from '../storage.service.js'
import type { ExecutionContext } from './handler-utils.js'

const baseContext: ExecutionContext = {
  workspaceId: 'ws-1',
  chatSessionId: 'session-1',
}

describe('executeDocumentSearch', () => {
  beforeEach(() => {
    mockPrisma = createMockPrisma()
    vi.clearAllMocks()
  })

  test('finds relevant documents and returns formatted output with sources', async () => {
    vi.mocked(searchService.search).mockResolvedValueOnce([
      { id: 'sr-1', payload: { chunkId: 'chunk-1' } },
    ] as never)
    mockPrisma.documentChunk.findMany.mockResolvedValueOnce([
      {
        id: 'chunk-1',
        content: 'Document content here',
        chunkIndex: 0,
        document: { title: 'Test Doc', id: 'doc-1' },
      },
    ] as never)

    const toolCall = { id: 'tc-1', name: 'search_documents', arguments: { query: 'test query' } }
    const result = await executeDocumentSearch(toolCall, baseContext)

    expect(embeddingService.embed).toHaveBeenCalledWith('test query')
    expect(result.output).toContain('[Source: Test Doc]')
    expect(result.output).toContain('Document content here')
    expect(result.sources).toHaveLength(1)
    expect(result.sources![0].documentId).toBe('doc-1')
    expect(result.sources![0].documentTitle).toBe('Test Doc')
  })

  test('returns no results message when nothing found', async () => {
    vi.mocked(searchService.search).mockResolvedValue([] as never)

    const toolCall = { id: 'tc-1', name: 'search_documents', arguments: { query: 'unknown' } }
    const result = await executeDocumentSearch(toolCall, baseContext)

    expect(result.output).toBe('No relevant documents found for this query.')
    expect(result.sources).toBeUndefined()
  })

  test('falls back to global search when workspace search yields no results', async () => {
    vi.mocked(searchService.search)
      .mockResolvedValueOnce([] as never) // workspace search
      .mockResolvedValueOnce([] as never) // global fallback

    const toolCall = { id: 'tc-1', name: 'search_documents', arguments: { query: 'test' } }
    const result = await executeDocumentSearch(toolCall, baseContext)

    expect(searchService.search).toHaveBeenCalledTimes(2)
    expect(result.output).toBe('No relevant documents found for this query.')
  })

  test('deduplicates sources by document ID', async () => {
    vi.mocked(searchService.search).mockResolvedValueOnce([
      { id: 'sr-1', payload: { chunkId: 'chunk-1' } },
      { id: 'sr-2', payload: { chunkId: 'chunk-2' } },
    ] as never)
    mockPrisma.documentChunk.findMany.mockResolvedValueOnce([
      {
        id: 'chunk-1',
        content: 'Content A',
        chunkIndex: 0,
        document: { title: 'Same Doc', id: 'doc-1' },
      },
      {
        id: 'chunk-2',
        content: 'Content B',
        chunkIndex: 1,
        document: { title: 'Same Doc', id: 'doc-1' },
      },
    ] as never)

    const toolCall = { id: 'tc-1', name: 'search_documents', arguments: { query: 'test' } }
    const result = await executeDocumentSearch(toolCall, baseContext)

    expect(result.sources).toHaveLength(1)
  })
})

describe('executeSaveDocument', () => {
  beforeEach(() => {
    mockPrisma = createMockPrisma()
    vi.clearAllMocks()
  })

  test('creates a new document and enqueues ingestion', async () => {
    ;(mockPrisma as Record<string, unknown>).folder = {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'folder-1' }),
    }
    mockPrisma.document.create.mockResolvedValue({ id: 'doc-new', title: 'My Note' } as never)

    const toolCall = {
      id: 'tc-1',
      name: 'save_document',
      arguments: { title: 'My Note', content: 'Some content' },
    }
    const result = await executeSaveDocument(toolCall, baseContext)

    expect(mockPrisma.document.create).toHaveBeenCalledTimes(1)
    const createData = mockPrisma.document.create.mock.calls[0][0].data
    expect(createData.title).toBe('My Note')
    expect(createData.content).toBe('Some content')
    expect(createData.workspaceId).toBe('ws-1')
    expect(ingestionService.enqueue).toHaveBeenCalledWith('doc-new')
    expect(result.output).toContain('saved successfully')
  })

  test('reuses existing __agent__ folder', async () => {
    ;(mockPrisma as Record<string, unknown>).folder = {
      findFirst: vi.fn().mockResolvedValue({ id: 'existing-folder' }),
      create: vi.fn(),
    }
    mockPrisma.document.create.mockResolvedValue({ id: 'doc-2' } as never)

    const toolCall = {
      id: 'tc-1',
      name: 'save_document',
      arguments: { title: 'T', content: 'C' },
    }
    await executeSaveDocument(toolCall, baseContext)

    expect(
      (mockPrisma as Record<string, { create: ReturnType<typeof vi.fn> }>).folder.create,
    ).not.toHaveBeenCalled()
    const createData = mockPrisma.document.create.mock.calls[0][0].data
    expect(createData.folderId).toBe('existing-folder')
  })
})

describe('executeGenerateFile', () => {
  beforeEach(() => {
    mockPrisma = createMockPrisma()
    vi.clearAllMocks()
  })

  test('generates file from content and uploads', async () => {
    const toolCall = {
      id: 'tc-1',
      name: 'generate_file',
      arguments: { filename: 'report.csv', content: 'a,b,c' },
    }
    const result = await executeGenerateFile(toolCall, baseContext)

    expect(storageService.upload).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(result.output)
    expect(parsed.filename).toBe('report.csv')
    expect(parsed.downloadUrl).toContain('/api/files/')
  })

  test('reads file from sandbox via sourcePath', async () => {
    vi.mocked(sandboxService.execInWorkspace).mockResolvedValue({
      stdout: 'file content from sandbox',
      stderr: '',
      exitCode: 0,
    })

    const toolCall = {
      id: 'tc-1',
      name: 'generate_file',
      arguments: { filename: 'data.txt', sourcePath: '/workspace/data.txt' },
    }
    const result = await executeGenerateFile(toolCall, baseContext)

    expect(storageService.upload).toHaveBeenCalledTimes(1)
    expect(result.error).toBeUndefined()
  })

  test('reads binary file from sandbox via sourcePath', async () => {
    vi.mocked(sandboxService.readFileFromContainer).mockResolvedValue(Buffer.from('binary-data'))

    const toolCall = {
      id: 'tc-1',
      name: 'generate_file',
      arguments: { filename: 'image.png', sourcePath: '/workspace/image.png' },
    }
    const result = await executeGenerateFile(toolCall, baseContext)

    expect(sandboxService.readFileFromContainer).toHaveBeenCalled()
    expect(result.error).toBeUndefined()
  })

  test('returns error when neither content nor sourcePath provided', async () => {
    const toolCall = {
      id: 'tc-1',
      name: 'generate_file',
      arguments: { filename: 'file.txt' },
    }
    const result = await executeGenerateFile(toolCall, baseContext)

    expect(result.error).toBe('Either content or sourcePath must be provided')
  })

  test('returns error when sourcePath used without workspace', async () => {
    const toolCall = {
      id: 'tc-1',
      name: 'generate_file',
      arguments: { filename: 'file.txt', sourcePath: '/workspace/file.txt' },
    }
    const result = await executeGenerateFile(toolCall, { ...baseContext, workspaceId: '' })

    expect(result.error).toContain('sourcePath requires an active sandbox')
  })
})

describe('executeReadFile', () => {
  beforeEach(() => {
    mockPrisma = createMockPrisma()
    vi.clearAllMocks()
  })

  test('reads file content with line numbers and header', async () => {
    vi.mocked(sandboxService.execInWorkspace).mockResolvedValue({
      stdout: '@@TOTAL:3@@\n     1\tline one\n     2\tline two\n     3\tline three',
      stderr: '',
      exitCode: 0,
    })

    const toolCall = {
      id: 'tc-1',
      name: 'read_file',
      arguments: { file_path: '/workspace/test.txt' },
    }
    const result = await executeReadFile(toolCall, baseContext)

    expect(result.output).toContain('[File: /workspace/test.txt]')
    expect(result.output).toContain('line one')
    expect(result.error).toBeUndefined()
  })

  test('returns error when file_path is empty', async () => {
    const toolCall = {
      id: 'tc-1',
      name: 'read_file',
      arguments: { file_path: '' },
    }
    const result = await executeReadFile(toolCall, baseContext)

    expect(result.error).toBe('file_path is required.')
  })

  test('returns error when no workspace available', async () => {
    const toolCall = {
      id: 'tc-1',
      name: 'read_file',
      arguments: { file_path: '/test.txt' },
    }
    const result = await executeReadFile(toolCall, { ...baseContext, workspaceId: '' })

    expect(result.error).toContain('requires an active sandbox session')
  })

  test('handles file not found sentinel', async () => {
    vi.mocked(sandboxService.execInWorkspace).mockResolvedValue({
      stdout: '@@NOT_FOUND@@',
      stderr: '',
      exitCode: 0,
    })

    const toolCall = {
      id: 'tc-1',
      name: 'read_file',
      arguments: { file_path: 'missing.txt' },
    }
    const result = await executeReadFile(toolCall, baseContext)

    expect(result.error).toContain('File not found')
  })

  test('handles directory sentinel', async () => {
    vi.mocked(sandboxService.execInWorkspace).mockResolvedValue({
      stdout: '@@IS_DIRECTORY@@',
      stderr: '',
      exitCode: 0,
    })

    const toolCall = {
      id: 'tc-1',
      name: 'read_file',
      arguments: { file_path: '/workspace/src' },
    }
    const result = await executeReadFile(toolCall, baseContext)

    expect(result.error).toContain('is a directory')
  })

  test('handles binary file sentinel', async () => {
    vi.mocked(sandboxService.execInWorkspace).mockResolvedValue({
      stdout: '@@BINARY@@',
      stderr: '',
      exitCode: 0,
    })

    const toolCall = {
      id: 'tc-1',
      name: 'read_file',
      arguments: { file_path: 'image.png' },
    }
    const result = await executeReadFile(toolCall, baseContext)

    expect(result.error).toContain('binary file')
  })

  test('handles empty file sentinel', async () => {
    vi.mocked(sandboxService.execInWorkspace).mockResolvedValue({
      stdout: '@@EMPTY@@',
      stderr: '',
      exitCode: 0,
    })

    const toolCall = {
      id: 'tc-1',
      name: 'read_file',
      arguments: { file_path: 'empty.txt' },
    }
    const result = await executeReadFile(toolCall, baseContext)

    expect(result.output).toContain('empty (0 lines)')
    expect(result.error).toBeUndefined()
  })
})
