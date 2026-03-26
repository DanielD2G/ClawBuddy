import { describe, expect, test, vi, beforeEach } from 'vitest'
import { createMockPrisma, type MockPrisma } from '@test/factories/prisma'

// ── Mocks ───────────────────────────────────────────────────────────────

let mockPrisma: MockPrisma

vi.mock('../lib/prisma.js', () => ({
  get prisma() {
    return mockPrisma
  },
}))

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('./secret-redaction.service.js', () => ({
  secretRedactionService: {
    buildSecretInventory: vi.fn().mockResolvedValue({
      workspaceId: 'ws-1',
      enabled: true,
      secretValues: [],
      secretPattern: null,
      aliases: [],
      references: [],
    }),
    redactForPublicStorage: vi.fn().mockImplementation((input: unknown) => input),
    redactSerializedText: vi.fn().mockImplementation((text: string) => text),
    redactText: vi.fn().mockImplementation((text: string) => text),
  },
}))

vi.mock('../lib/sanitize.js', () => ({
  stripNullBytes: vi.fn().mockImplementation((s: string) => s),
  stripNullBytesOrNull: vi.fn().mockImplementation((s: string | null) => s),
}))

vi.mock('../lib/screenshot.js', () => ({
  extractScreenshotBase64: vi.fn().mockReturnValue({ screenshotB64: null, description: null }),
}))

// Mock all handler modules — use inline vi.fn() to avoid hoisting issues
vi.mock('./tools/document.handler.js', () => ({
  executeDocumentSearch: vi.fn().mockResolvedValue({ output: 'doc results', durationMs: 10 }),
  executeSaveDocument: vi.fn().mockResolvedValue({ output: 'doc saved', durationMs: 10 }),
  executeGenerateFile: vi.fn().mockResolvedValue({ output: 'file generated', durationMs: 10 }),
  executeReadFile: vi.fn().mockResolvedValue({ output: 'file content', durationMs: 10 }),
}))

vi.mock('./tools/fetch.handler.js', () => ({
  executeWebFetch: vi.fn().mockResolvedValue({ output: 'fetched', durationMs: 10 }),
  executeWebSearch: vi.fn().mockResolvedValue({ output: 'search results', durationMs: 10 }),
}))

vi.mock('./tools/browser.handler.js', () => ({
  executeBrowserScript: vi.fn().mockResolvedValue({ output: 'browser done', durationMs: 10 }),
}))

vi.mock('./tools/sandbox.handler.js', () => ({
  executeSandboxCommand: vi.fn().mockResolvedValue({ output: 'sandbox output', durationMs: 10 }),
}))

vi.mock('./tools/system.handler.js', () => ({
  executeCreateCron: vi.fn().mockResolvedValue({ output: 'cron created', durationMs: 10 }),
  executeListCrons: vi.fn().mockResolvedValue({ output: 'crons listed', durationMs: 10 }),
  executeDeleteCron: vi.fn().mockResolvedValue({ output: 'cron deleted', durationMs: 10 }),
  executeDiscoverTools: vi.fn().mockResolvedValue({ output: 'tools found', durationMs: 10 }),
  executeDelegateTask: vi.fn().mockResolvedValue({ output: 'task delegated', durationMs: 10 }),
}))

// Now import — vi.mock is hoisted, so these get the mocked versions
import { toolExecutorService, NON_SANDBOX_TOOLS } from './tool-executor.service.js'
import { extractScreenshotBase64 } from '../lib/screenshot.js'
import { secretRedactionService } from './secret-redaction.service.js'
import { executeDocumentSearch, executeSaveDocument } from './tools/document.handler.js'
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

const baseContext = {
  workspaceId: 'ws-1',
  chatSessionId: 'session-1',
}

describe('toolExecutorService', () => {
  beforeEach(() => {
    mockPrisma = createMockPrisma()
    vi.clearAllMocks()
  })

  // ── Routing ──────────────────────────────────────────────────────────

  describe('execute - routing', () => {
    test('routes search_documents to document handler', async () => {
      const toolCall = { id: 'tc-1', name: 'search_documents', arguments: { query: 'test' } }
      const result = await toolExecutorService.execute(toolCall, 'cap-slug', baseContext)
      expect(executeDocumentSearch).toHaveBeenCalledWith(toolCall, baseContext)
      expect(result.output).toBe('doc results')
    })

    test('routes save_document to document handler', async () => {
      const toolCall = {
        id: 'tc-2',
        name: 'save_document',
        arguments: { title: 'T', content: 'C' },
      }
      await toolExecutorService.execute(toolCall, 'cap-slug', baseContext)
      expect(executeSaveDocument).toHaveBeenCalledWith(toolCall, baseContext)
    })

    test('routes web_search to fetch handler', async () => {
      const toolCall = { id: 'tc-3', name: 'web_search', arguments: { query: 'hello' } }
      await toolExecutorService.execute(toolCall, 'cap-slug', baseContext)
      expect(executeWebSearch).toHaveBeenCalledWith(toolCall)
    })

    test('routes web_fetch to fetch handler', async () => {
      const toolCall = { id: 'tc-4', name: 'web_fetch', arguments: { url: 'http://x.com' } }
      await toolExecutorService.execute(toolCall, 'cap-slug', baseContext)
      expect(executeWebFetch).toHaveBeenCalledWith(toolCall)
    })

    test('routes run_browser_script to browser handler', async () => {
      const toolCall = { id: 'tc-5', name: 'run_browser_script', arguments: { script: 'x' } }
      await toolExecutorService.execute(toolCall, 'cap-slug', baseContext)
      expect(executeBrowserScript).toHaveBeenCalledWith(toolCall, baseContext)
    })

    test('routes create_cron to system handler', async () => {
      const toolCall = { id: 'tc-6', name: 'create_cron', arguments: { name: 'j' } }
      await toolExecutorService.execute(toolCall, 'cap-slug', baseContext)
      expect(executeCreateCron).toHaveBeenCalledWith(toolCall, baseContext)
    })

    test('routes list_crons to system handler', async () => {
      const toolCall = { id: 'tc-7', name: 'list_crons', arguments: {} }
      await toolExecutorService.execute(toolCall, 'cap-slug', baseContext)
      expect(executeListCrons).toHaveBeenCalledWith(baseContext)
    })

    test('routes delete_cron to system handler', async () => {
      const toolCall = { id: 'tc-8', name: 'delete_cron', arguments: { id: 'cron-1' } }
      await toolExecutorService.execute(toolCall, 'cap-slug', baseContext)
      expect(executeDeleteCron).toHaveBeenCalledWith(toolCall)
    })

    test('routes discover_tools to system handler', async () => {
      const toolCall = { id: 'tc-9', name: 'discover_tools', arguments: { query: 'x' } }
      await toolExecutorService.execute(toolCall, 'cap-slug', baseContext)
      expect(executeDiscoverTools).toHaveBeenCalledWith(toolCall, baseContext)
    })

    test('routes delegate_task to system handler', async () => {
      const toolCall = {
        id: 'tc-10',
        name: 'delegate_task',
        arguments: { role: 'r', task: 't' },
      }
      await toolExecutorService.execute(toolCall, 'cap-slug', baseContext)
      expect(executeDelegateTask).toHaveBeenCalledWith(toolCall, baseContext)
    })

    test('falls back to sandbox for unknown tools', async () => {
      const toolCall = { id: 'tc-11', name: 'run_bash', arguments: { command: 'ls' } }
      await toolExecutorService.execute(toolCall, 'cap-slug', baseContext)
      expect(executeSandboxCommand).toHaveBeenCalledWith(toolCall, 'cap-slug', baseContext)
    })
  })

  // ── DB Recording ─────────────────────────────────────────────────────

  describe('execute - DB recording', () => {
    test('creates a toolExecution record on success', async () => {
      const toolCall = { id: 'tc-1', name: 'search_documents', arguments: { query: 'test' } }
      mockPrisma.toolExecution.create.mockResolvedValue({ id: 'exec-1' })

      const result = await toolExecutorService.execute(toolCall, 'my-cap', baseContext)

      expect(mockPrisma.toolExecution.create).toHaveBeenCalledTimes(1)
      const createArg = mockPrisma.toolExecution.create.mock.calls[0][0]
      expect(createArg.data.capabilitySlug).toBe('my-cap')
      expect(createArg.data.toolName).toBe('search_documents')
      expect(createArg.data.status).toBe('completed')
      expect(result.executionId).toBe('exec-1')
    })

    test('creates a toolExecution record with failed status on handler error', async () => {
      vi.mocked(executeDocumentSearch).mockResolvedValueOnce({
        output: '',
        error: 'something broke',
        durationMs: 5,
      })
      mockPrisma.toolExecution.create.mockResolvedValue({ id: 'exec-2' })

      const toolCall = { id: 'tc-1', name: 'search_documents', arguments: { query: 'test' } }
      const result = await toolExecutorService.execute(toolCall, 'my-cap', baseContext)

      const createArg = mockPrisma.toolExecution.create.mock.calls[0][0]
      expect(createArg.data.status).toBe('failed')
      expect(result.error).toBe('something broke')
    })

    test('records execution even when handler throws', async () => {
      vi.mocked(executeDocumentSearch).mockRejectedValueOnce(new Error('boom'))
      mockPrisma.toolExecution.create.mockResolvedValue({ id: 'exec-3' })

      const toolCall = { id: 'tc-1', name: 'search_documents', arguments: { query: 'test' } }
      const result = await toolExecutorService.execute(toolCall, 'my-cap', baseContext)

      expect(mockPrisma.toolExecution.create).toHaveBeenCalledTimes(1)
      expect(result.error).toBe('boom')
      expect(result.executionId).toBe('exec-3')
    })
  })

  // ── Secret Redaction ─────────────────────────────────────────────────

  describe('execute - secret redaction', () => {
    test('redacts input and output using secret inventory', async () => {
      const toolCall = { id: 'tc-1', name: 'search_documents', arguments: { query: 'secret' } }
      await toolExecutorService.execute(toolCall, 'cap-slug', baseContext)

      expect(secretRedactionService.redactForPublicStorage).toHaveBeenCalled()
      expect(secretRedactionService.redactSerializedText).toHaveBeenCalled()
    })

    test('builds secret inventory when not provided in context', async () => {
      const toolCall = { id: 'tc-1', name: 'search_documents', arguments: { query: 'x' } }
      await toolExecutorService.execute(toolCall, 'cap-slug', baseContext)

      expect(secretRedactionService.buildSecretInventory).toHaveBeenCalledWith('ws-1')
    })

    test('uses provided secret inventory from context', async () => {
      const inventory = {
        workspaceId: 'ws-1',
        enabled: true,
        secretValues: ['secret-val'],
        secretPattern: /secret-val/g,
        aliases: [],
        references: [],
      }
      const toolCall = { id: 'tc-1', name: 'search_documents', arguments: { query: 'x' } }
      await toolExecutorService.execute(toolCall, 'cap-slug', {
        ...baseContext,
        secretInventory: inventory,
      })

      expect(secretRedactionService.buildSecretInventory).not.toHaveBeenCalled()
    })
  })

  // ── Screenshot Extraction ────────────────────────────────────────────

  describe('execute - screenshot extraction', () => {
    test('extracts screenshot from run_browser_script output', async () => {
      vi.mocked(extractScreenshotBase64).mockReturnValueOnce({
        screenshotB64: 'base64data',
        description: 'Page loaded',
      })
      vi.mocked(executeBrowserScript).mockResolvedValueOnce({
        output: '{"screenshot":"base64data","description":"Page loaded"}',
        durationMs: 10,
      })
      mockPrisma.toolExecution.create.mockResolvedValue({ id: 'exec-s' })

      const toolCall = { id: 'tc-1', name: 'run_browser_script', arguments: { script: 'x' } }
      await toolExecutorService.execute(toolCall, 'cap-slug', baseContext)

      const createArg = mockPrisma.toolExecution.create.mock.calls[0][0]
      expect(createArg.data.screenshot).toBe('data:image/jpeg;base64,base64data')
      expect(createArg.data.output).toBe('Page loaded')
    })

    test('does not extract screenshot for non-browser tools', async () => {
      const toolCall = { id: 'tc-1', name: 'search_documents', arguments: { query: 'x' } }
      await toolExecutorService.execute(toolCall, 'cap-slug', baseContext)

      expect(extractScreenshotBase64).not.toHaveBeenCalled()
    })
  })

  // ── needsSandbox ─────────────────────────────────────────────────────

  describe('needsSandbox', () => {
    test('returns true when at least one tool is not in the registry', () => {
      expect(toolExecutorService.needsSandbox(['run_bash'])).toBe(true)
    })

    test('returns false when all tools are in the registry', () => {
      expect(toolExecutorService.needsSandbox(['search_documents', 'web_search'])).toBe(false)
    })

    test('NON_SANDBOX_TOOLS contains all registered tool names', () => {
      expect(NON_SANDBOX_TOOLS.has('search_documents')).toBe(true)
      expect(NON_SANDBOX_TOOLS.has('run_browser_script')).toBe(true)
      expect(NON_SANDBOX_TOOLS.has('delegate_task')).toBe(true)
      expect(NON_SANDBOX_TOOLS.has('run_bash')).toBe(false)
    })
  })
})
