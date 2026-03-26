import { describe, expect, test, vi, beforeEach } from 'vitest'
import { createMockPrisma, type MockPrisma } from '@test/factories/prisma'

// ── Hoisted mocks ───────────────────────────────────────────────────────

const { mockExecute } = vi.hoisted(() => ({
  mockExecute: vi.fn().mockResolvedValue({
    output: 'tool output',
    durationMs: 100,
    exitCode: 0,
  }),
}))

// ── Mocks ───────────────────────────────────────────────────────────────

let mockPrisma: MockPrisma

vi.mock('@prisma/client', () => ({
  Prisma: {
    InputJsonValue: {},
  },
}))

vi.mock('../lib/prisma.js', () => ({
  get prisma() {
    return mockPrisma
  },
}))

vi.mock('../lib/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../lib/sanitize.js', () => ({
  stripNullBytes: vi.fn().mockImplementation((s: string) => s),
}))

vi.mock('./capability.service.js', () => ({
  capabilityService: {
    buildToolDefinitions: vi.fn().mockReturnValue([]),
  },
}))

vi.mock('./tool-executor.service.js', () => ({
  toolExecutorService: {
    execute: mockExecute,
  },
  NON_SANDBOX_TOOLS: new Set([
    'search_documents',
    'save_document',
    'generate_file',
    'read_file',
    'create_cron',
    'list_crons',
    'delete_cron',
    'web_search',
    'web_fetch',
    'run_browser_script',
    'discover_tools',
    'delegate_task',
  ]),
}))

vi.mock('./permission.service.js', () => ({
  permissionService: {
    isToolAllowed: vi.fn().mockReturnValue(true),
  },
}))

vi.mock('../constants.js', () => ({
  PARALLEL_SAFE_TOOLS: new Set(['read_file']),
  LARGE_TOOL_ARG_THRESHOLD: 2000,
  DELEGATION_ONLY_TOOLS: new Set(['run_browser_script']),
}))

vi.mock('./secret-redaction.service.js', () => ({
  secretRedactionService: {
    redactForPublicStorage: vi.fn().mockImplementation((v: unknown) => v),
  },
}))

vi.mock('./agent-tool-results.service.js', () => ({
  buildToolResultContent: vi.fn().mockImplementation((content: string) => content),
  maybeTruncateOutput: vi.fn().mockImplementation(async (content: string) => content),
  prepareToolResultForSSE: vi.fn().mockReturnValue({ output: 'tool output' }),
}))

vi.mock('./agent-debug.service.js', () => ({
  createSessionLogger: vi.fn().mockReturnValue({
    debugLog: vi.fn(),
    logLLMRequest: vi.fn(),
    logLLMResponse: vi.fn(),
    logToolResult: vi.fn(),
  }),
}))

vi.mock('./sub-agent-roles.js', () => ({
  SUB_AGENT_ROLES: {
    explore: { description: 'Explore role', tools: ['read_file'] },
    execute: { description: 'Execute role', tools: ['run_bash'] },
  },
}))

vi.mock('./sub-agent.types.js', () => ({}))

vi.mock('./sub-agent.service.js', () => ({
  filterTools: vi.fn().mockReturnValue([{ name: 'read_file' }]),
}))

vi.mock('./agent-state.service.js', () => ({
  serializeEncryptedAgentState: vi.fn().mockReturnValue('encrypted-state'),
  buildPublicAgentState: vi.fn().mockReturnValue({ iteration: 0 }),
}))

vi.mock('./agent-token.service.js', () => ({
  checkToolArgSize: vi.fn().mockReturnValue(null),
}))

vi.mock('./agent-conversation-state.js', () => ({
  persistConversationLoadedCapabilitySlugs: vi.fn().mockResolvedValue([]),
}))

import type { ToolDispatchContext } from './agent-tool-dispatch.js'
import {
  resolveSubAgentMeta,
  contentOverlapRatio,
  resolveCapability,
  preCheckTool,
  executeSingleTool,
  executeToolCalls,
  persistIterationMessage,
  getEmptyFinalResponseFallback,
  logToolCallSizes,
} from './agent-tool-dispatch.js'
import { permissionService } from './permission.service.js'
import { checkToolArgSize } from './agent-token.service.js'

// ── Helpers ─────────────────────────────────────────────────────────────

function createMockSessionLogger() {
  return {
    debugLog: vi.fn(),
    logLLMRequest: vi.fn(),
    logLLMResponse: vi.fn(),
    logToolResult: vi.fn(),
  }
}

function createDispatchContext(overrides?: Partial<ToolDispatchContext>): ToolDispatchContext {
  return {
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    inventory: {
      enabled: false,
      secretValues: [],
      secretPattern: null,
      aliases: [],
      references: [],
    } as never,
    emit: vi.fn(),
    log: createMockSessionLogger(),
    messages: [],
    toolExecutionLog: [],
    collectedSources: [],
    capabilities: [],
    tools: [{ name: 'run_bash', description: 'Run bash', parameters: {} }],
    allowRules: [],
    autoApprove: false,
    sandboxReady: true,
    modelId: 'gpt-4o',
    discoveredCapabilities: [],
    enabledCapabilitySlugs: new Set(),
    conversationLoadedCapabilitySlugs: [],
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('resolveSubAgentMeta', () => {
  test('returns empty object for non-delegate_task tools', () => {
    const result = resolveSubAgentMeta(
      { id: 'tc-1', name: 'run_bash', arguments: { command: 'ls' } },
      [],
    )
    expect(result).toEqual({})
  })

  test('returns metadata for delegate_task with valid role', () => {
    const result = resolveSubAgentMeta(
      { id: 'tc-1', name: 'delegate_task', arguments: { role: 'explore', task: 'find files' } },
      [],
    )
    expect(result).toHaveProperty('subAgentRole', 'explore')
    expect(result).toHaveProperty('subAgentDescription')
    expect(result).toHaveProperty('subAgentToolNames')
  })

  test('returns empty object for delegate_task with unknown role', () => {
    const result = resolveSubAgentMeta(
      { id: 'tc-1', name: 'delegate_task', arguments: { role: 'unknown_role', task: 'x' } },
      [],
    )
    expect(result).toEqual({})
  })
})

describe('contentOverlapRatio', () => {
  test('returns 0 for completely different texts', () => {
    const ratio = contentOverlapRatio('the quick brown fox', 'lorem ipsum dolor sit amet')
    expect(ratio).toBe(0)
  })

  test('returns 1 for identical texts', () => {
    const ratio = contentOverlapRatio(
      'the quick brown fox jumps over the lazy dog',
      'the quick brown fox jumps over the lazy dog',
    )
    expect(ratio).toBe(1)
  })

  test('returns high ratio for mostly overlapping texts', () => {
    const prev = 'the quick brown fox jumps over the lazy dog in the park'
    const next = 'the quick brown fox jumps over the lazy dog in the park today'
    const ratio = contentOverlapRatio(prev, next)
    expect(ratio).toBeGreaterThan(0.7)
  })

  test('returns 0 when previous text is empty', () => {
    const ratio = contentOverlapRatio('', 'some text here now')
    expect(ratio).toBe(0)
  })

  test('returns 0 when new text is empty', () => {
    const ratio = contentOverlapRatio('some text here now', '')
    expect(ratio).toBe(0)
  })

  test('handles short texts with fewer words than ngram size', () => {
    const ratio = contentOverlapRatio('hello world', 'hello world')
    expect(ratio).toBe(1)
  })

  test('handles short texts that do not match', () => {
    const ratio = contentOverlapRatio('hello world', 'goodbye earth')
    expect(ratio).toBe(0)
  })
})

describe('resolveCapability', () => {
  test('matches tool to capability by tool definition name', () => {
    const capabilities = [
      {
        slug: 'shell',
        name: 'Shell',
        toolDefinitions: [{ name: 'run_bash' }],
        systemPrompt: '',
      },
    ] as ToolDispatchContext['capabilities']

    const { matchedCapability, capabilitySlug } = resolveCapability(
      { id: 'tc-1', name: 'run_bash', arguments: {} },
      capabilities,
      [],
    )
    expect(capabilitySlug).toBe('shell')
    expect(matchedCapability?.slug).toBe('shell')
  })

  test('falls back to discovered capabilities', () => {
    const discovered = [
      {
        slug: 'custom-cap',
        name: 'Custom',
        toolDefinitions: [{ name: 'custom_tool', description: '', parameters: {} }],
        systemPrompt: '',
      },
    ] as ToolDispatchContext['discoveredCapabilities']

    const { capabilitySlug } = resolveCapability(
      { id: 'tc-1', name: 'custom_tool', arguments: {} },
      [],
      discovered,
    )
    expect(capabilitySlug).toBe('custom-cap')
  })

  test('returns tool-discovery slug for discover_tools', () => {
    const { capabilitySlug } = resolveCapability(
      { id: 'tc-1', name: 'discover_tools', arguments: {} },
      [],
      [],
    )
    expect(capabilitySlug).toBe('tool-discovery')
  })

  test('returns unknown for unmatched tool', () => {
    const { capabilitySlug, matchedCapability } = resolveCapability(
      { id: 'tc-1', name: 'nonexistent_tool', arguments: {} },
      [],
      [],
    )
    expect(capabilitySlug).toBe('unknown')
    expect(matchedCapability).toBeUndefined()
  })
})

describe('getEmptyFinalResponseFallback', () => {
  test('returns tool-aware fallback when hasToolResults is true', () => {
    const msg = getEmptyFinalResponseFallback(true)
    expect(msg).toContain('found relevant results')
  })

  test('returns generic fallback when hasToolResults is false', () => {
    const msg = getEmptyFinalResponseFallback(false)
    expect(msg).toContain('could not generate a response')
  })
})

describe('logToolCallSizes', () => {
  test('logs sizes for each tool call', () => {
    const log = createMockSessionLogger()
    logToolCallSizes([{ id: 'tc-1', name: 'run_bash', arguments: { command: 'ls' } }], log)
    expect(log.debugLog).toHaveBeenCalledWith(
      expect.stringContaining('[TOOL_SIZE]'),
      expect.any(Object),
    )
  })
})

describe('preCheckTool', () => {
  beforeEach(() => {
    mockPrisma = createMockPrisma()
    vi.mocked(permissionService.isToolAllowed).mockReturnValue(true)
    vi.mocked(checkToolArgSize).mockReturnValue(null)
  })

  test('returns ok when tool passes all checks', async () => {
    const ctx = createDispatchContext()
    const result = await preCheckTool(
      ctx,
      { id: 'tc-1', name: 'run_bash', arguments: { command: 'ls' } },
      'shell',
      undefined,
      { command: 'ls' },
      0,
      [],
    )
    expect(result).toBe('ok')
  })

  test('rejects undiscovered tools not in available tools list', async () => {
    const ctx = createDispatchContext({
      tools: [{ name: 'discover_tools', description: 'Discover', parameters: {} }],
    })

    const result = await preCheckTool(
      ctx,
      { id: 'tc-1', name: 'unknown_tool', arguments: {} },
      'unknown',
      undefined,
      {},
      0,
      [],
    )
    expect(result).toBe('rejected')
    expect(ctx.messages).toHaveLength(1)
    expect(ctx.messages[0].content).toContain('not yet available')
  })

  test('pauses for approval when tool is not allowed and not auto-approve', async () => {
    vi.mocked(permissionService.isToolAllowed).mockReturnValue(false)
    mockPrisma.toolApproval = {
      create: vi.fn().mockResolvedValue({ id: 'approval-1' }),
      findMany: vi.fn().mockResolvedValue([{ id: 'approval-1' }]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    } as never

    const ctx = createDispatchContext({ autoApprove: false })
    const result = await preCheckTool(
      ctx,
      { id: 'tc-1', name: 'run_bash', arguments: { command: 'rm -rf /' } },
      'shell',
      undefined,
      { command: 'rm -rf /' },
      0,
      [{ id: 'tc-1', name: 'run_bash', arguments: { command: 'rm -rf /' } }],
    )
    expect(result).toBe('paused')
  })

  test('allows tool when auto-approve is true even if not in allow rules', async () => {
    vi.mocked(permissionService.isToolAllowed).mockReturnValue(false)

    const ctx = createDispatchContext({ autoApprove: true })
    const result = await preCheckTool(
      ctx,
      { id: 'tc-1', name: 'run_bash', arguments: { command: 'ls' } },
      'shell',
      undefined,
      { command: 'ls' },
      0,
      [],
    )
    // autoApprove bypasses the permission check
    expect(result).toBe('ok')
  })

  test('rejects tool when size guard triggers', async () => {
    vi.mocked(checkToolArgSize).mockReturnValue('[BLOCKED] too large')

    const ctx = createDispatchContext()
    const result = await preCheckTool(
      ctx,
      { id: 'tc-1', name: 'run_bash', arguments: { command: 'x'.repeat(20000) } },
      'shell',
      undefined,
      { command: '...' },
      0,
      [],
    )
    expect(result).toBe('rejected')
    expect(ctx.messages).toHaveLength(1)
    expect(ctx.messages[0].content).toContain('[BLOCKED]')
  })
})

describe('executeSingleTool', () => {
  beforeEach(() => {
    mockPrisma = createMockPrisma()
    mockExecute.mockResolvedValue({
      output: 'tool output',
      durationMs: 100,
      exitCode: 0,
    })
  })

  test('delegates to tool executor and returns result', async () => {
    const ctx = createDispatchContext()
    const result = await executeSingleTool(
      ctx,
      { id: 'tc-1', name: 'run_bash', arguments: { command: 'ls' } },
      'shell',
      undefined,
      { command: 'ls' },
    )

    expect(result.output).toBe('tool output')
    expect(result.durationMs).toBe(100)
    expect(mockExecute).toHaveBeenCalled()
  })

  test('emits thinking event for discover_tools', async () => {
    const ctx = createDispatchContext()
    await executeSingleTool(
      ctx,
      { id: 'tc-1', name: 'discover_tools', arguments: { query: 'search' } },
      'tool-discovery',
      undefined,
      { query: 'search' },
    )
    expect(ctx.emit).toHaveBeenCalledWith('thinking', { message: 'Looking for the right tools...' })
  })

  test('emits tool_start event', async () => {
    const ctx = createDispatchContext()
    await executeSingleTool(
      ctx,
      { id: 'tc-1', name: 'run_bash', arguments: { command: 'ls' } },
      'shell',
      undefined,
      { command: 'ls' },
    )
    expect(ctx.emit).toHaveBeenCalledWith(
      'tool_start',
      expect.objectContaining({
        toolCallId: 'tc-1',
        toolName: 'run_bash',
      }),
    )
  })

  test('handles tool executor error', async () => {
    mockExecute.mockResolvedValue({
      output: '',
      error: 'Command failed',
      durationMs: 50,
      exitCode: 1,
    })

    const ctx = createDispatchContext()
    const result = await executeSingleTool(
      ctx,
      { id: 'tc-1', name: 'run_bash', arguments: { command: 'bad' } },
      'shell',
      undefined,
      { command: 'bad' },
    )
    expect(result.error).toBe('Command failed')
    expect(result.exitCode).toBe(1)
  })
})

describe('executeToolCalls', () => {
  beforeEach(() => {
    mockPrisma = createMockPrisma()
    vi.mocked(permissionService.isToolAllowed).mockReturnValue(true)
    vi.mocked(checkToolArgSize).mockReturnValue(null)
    mockExecute.mockResolvedValue({
      output: 'result',
      durationMs: 50,
      exitCode: 0,
    })
  })

  test('returns done when all tools execute successfully', async () => {
    const ctx = createDispatchContext({
      capabilities: [
        {
          slug: 'shell',
          name: 'Shell',
          toolDefinitions: [{ name: 'run_bash' }],
          systemPrompt: '',
          networkAccess: false,
        },
      ] as ToolDispatchContext['capabilities'],
    })

    const { status } = await executeToolCalls(
      ctx,
      [{ id: 'tc-1', name: 'run_bash', arguments: { command: 'ls' } }],
      0,
    )
    expect(status).toBe('done')
  })

  test('returns paused when pre-check pauses for approval', async () => {
    vi.mocked(permissionService.isToolAllowed).mockReturnValue(false)
    mockPrisma.toolApproval = {
      create: vi.fn().mockResolvedValue({ id: 'approval-1' }),
      findMany: vi.fn().mockResolvedValue([{ id: 'approval-1' }]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    } as never

    const ctx = createDispatchContext({ autoApprove: false })
    const { status } = await executeToolCalls(
      ctx,
      [{ id: 'tc-1', name: 'run_bash', arguments: { command: 'rm -rf /' } }],
      0,
    )
    expect(status).toBe('paused')
  })

  test('collects execution IDs from results', async () => {
    mockExecute.mockResolvedValue({
      output: 'result',
      durationMs: 50,
      exitCode: 0,
      executionId: 'exec-1',
    })

    const ctx = createDispatchContext({
      capabilities: [
        {
          slug: 'shell',
          name: 'Shell',
          toolDefinitions: [{ name: 'run_bash' }],
          systemPrompt: '',
          networkAccess: false,
        },
      ] as ToolDispatchContext['capabilities'],
    })

    const { executionIds } = await executeToolCalls(
      ctx,
      [{ id: 'tc-1', name: 'run_bash', arguments: { command: 'ls' } }],
      0,
    )
    expect(executionIds).toContain('exec-1')
  })
})

describe('persistIterationMessage', () => {
  beforeEach(() => {
    mockPrisma = createMockPrisma()
    mockPrisma.chatMessage.create.mockResolvedValue({ id: 'msg-1', createdAt: new Date() })
    mockPrisma.toolExecution.updateMany.mockResolvedValue({ count: 0 })
  })

  test('saves iteration to database', async () => {
    const ctx = createDispatchContext()
    const result = await persistIterationMessage(
      ctx,
      'Assistant response',
      [{ id: 'tc-1', name: 'run_bash', arguments: { command: 'ls' } }],
      ['exec-1'],
    )

    expect(result).toBe('msg-1')
    expect(mockPrisma.chatMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: 'session-1',
        role: 'assistant',
        content: 'Assistant response',
      }),
    })
  })

  test('updates tool executions with message ID', async () => {
    const ctx = createDispatchContext()
    await persistIterationMessage(
      ctx,
      'Response',
      [{ id: 'tc-1', name: 'run_bash', arguments: {} }],
      ['exec-1', 'exec-2'],
    )

    expect(mockPrisma.toolExecution.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['exec-1', 'exec-2'] } },
      data: { chatMessageId: 'msg-1' },
    })
  })

  test('returns undefined on DB failure', async () => {
    mockPrisma.chatMessage.create.mockRejectedValue(new Error('DB error'))

    const ctx = createDispatchContext()
    const result = await persistIterationMessage(
      ctx,
      'Response',
      [{ id: 'tc-1', name: 'run_bash', arguments: {} }],
      [],
    )
    expect(result).toBeUndefined()
  })

  test('skips tool execution update when no execution IDs', async () => {
    const ctx = createDispatchContext()
    await persistIterationMessage(
      ctx,
      'Response',
      [{ id: 'tc-1', name: 'run_bash', arguments: {} }],
      [],
    )

    expect(mockPrisma.toolExecution.updateMany).not.toHaveBeenCalled()
  })
})
