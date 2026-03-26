import { describe, expect, test, vi, beforeEach } from 'vitest'
import { createMockPrisma, type MockPrisma } from '@test/factories/prisma'
import { createMockLLMProvider } from '@test/factories/llm'
import { createMockSSEEmit } from '@test/factories/sse'

// ── Hoisted mocks ───────────────────────────────────────────────────────

const { mockLLM, mockRecordTokenUsage, mockExecuteToolCalls, mockPersistIterationMessage } =
  vi.hoisted(() => {
    const defaultResponse = {
      content: 'Hello, I can help you with that.',
      toolCalls: [],
      finishReason: 'stop' as const,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    }
    return {
      mockLLM: {
        modelId: 'mock-model',
        providerId: 'mock-provider',
        chat: vi.fn().mockResolvedValue(defaultResponse.content),
        chatWithTools: vi.fn().mockResolvedValue(defaultResponse),
        stream: vi.fn(),
      },
      mockRecordTokenUsage: vi.fn(),
      mockExecuteToolCalls: vi.fn().mockResolvedValue({ status: 'done', executionIds: [] }),
      mockPersistIterationMessage: vi.fn().mockResolvedValue('iter-msg-1'),
    }
  })

// ── Mocks ───────────────────────────────────────────────────────────────

let mockPrisma: MockPrisma

vi.mock('@prisma/client', () => ({
  Prisma: {
    DbNull: 'DbNull',
    InputJsonValue: {},
  },
}))

vi.mock('../lib/prisma.js', () => ({
  get prisma() {
    return mockPrisma
  },
}))

vi.mock('../providers/index.js', () => ({
  createLLMProvider: vi.fn().mockResolvedValue(mockLLM),
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

vi.mock('../lib/llm-retry.js', () => ({
  retryProviderTimeoutOnce: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => fn()),
}))

vi.mock('./capability.service.js', () => ({
  capabilityService: {
    getEnabledCapabilitiesForWorkspace: vi.fn().mockResolvedValue([]),
    buildToolDefinitions: vi.fn().mockReturnValue([]),
    buildSystemPrompt: vi.fn().mockReturnValue('You are a helpful assistant.'),
    getDecryptedCapabilityConfigsForWorkspace: vi.fn().mockResolvedValue(new Map()),
  },
}))

vi.mock('./tool-executor.service.js', () => ({
  toolExecutorService: {
    execute: vi.fn().mockResolvedValue({ output: 'done', durationMs: 50, exitCode: 0 }),
    needsSandbox: vi.fn().mockReturnValue(false),
  },
  NON_SANDBOX_TOOLS: new Set(['discover_tools']),
}))

vi.mock('./sandbox.service.js', () => ({
  sandboxService: {
    getOrCreateWorkspaceContainer: vi.fn().mockResolvedValue('container-1'),
  },
}))

vi.mock('./context-compression.service.js', () => ({
  compressContext: vi.fn().mockResolvedValue({
    compressed: false,
    summary: null,
    recentMessages: [],
    lastSummarizedMessageId: null,
  }),
}))

vi.mock('./settings.service.js', () => ({
  settingsService: {
    getTimezone: vi.fn().mockResolvedValue('UTC'),
    getContextLimitTokens: vi.fn().mockResolvedValue(128000),
    getMaxAgentIterations: vi.fn().mockResolvedValue(25),
  },
}))

vi.mock('../constants.js', () => ({
  MAX_AGENT_DOCUMENTS: 50,
  TOOL_DISCOVERY_THRESHOLD: 5,
  ALWAYS_ON_CAPABILITY_SLUGS: ['bash'],
  PREFLIGHT_DISCOVERY_SCORE_THRESHOLD: 0.5,
  DELEGATION_ONLY_TOOLS: new Set(['run_browser_script']),
  PARALLEL_SAFE_TOOLS: new Set(['read_file']),
  LARGE_TOOL_ARG_THRESHOLD: 2000,
}))

vi.mock('./tool-discovery.service.js', () => ({
  toolDiscoveryService: {
    buildDiscoveryContext: vi.fn().mockReturnValue({
      tools: [],
      systemPrompt: 'system',
      alwaysOnSlugs: [],
    }),
    search: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('./secret-redaction.service.js', () => ({
  secretRedactionService: {
    buildSecretInventory: vi
      .fn()
      .mockResolvedValue({ enabled: false, secrets: [], references: [] }),
    redactForPublicStorage: vi.fn().mockImplementation((v: unknown) => v),
  },
}))

vi.mock('./agent-message-builder.js', () => ({
  buildConversationMessages: vi.fn().mockImplementation(({ systemPrompt, currentUserContent }) => [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: currentUserContent },
  ]),
}))

vi.mock('./agent-tool-results.service.js', () => ({
  pruneOldToolResults: vi.fn().mockReturnValue(0),
  prepareToolResultForSSE: vi.fn().mockReturnValue({ output: 'result' }),
  maybeTruncateOutput: vi.fn().mockImplementation(async (content: string) => content),
}))

vi.mock('./agent-debug.service.js', () => ({
  createSessionLogger: vi.fn().mockReturnValue({
    debugLog: vi.fn(),
    logLLMRequest: vi.fn(),
    logLLMResponse: vi.fn(),
    logToolResult: vi.fn(),
  }),
}))

vi.mock('./system-prompt-builder.js', () => ({
  buildCapabilityBlocks: vi.fn().mockReturnValue(''),
  buildPromptSection: vi.fn().mockImplementation((_n: string, c: string) => c),
}))

vi.mock('./agent-state.service.js', () => ({
  deserializeAgentState: vi.fn().mockReturnValue(null),
  serializeEncryptedAgentState: vi.fn().mockReturnValue('encrypted'),
  buildPublicAgentState: vi.fn().mockReturnValue({ iteration: 0 }),
}))

vi.mock('./session-state.service.js', () => ({
  buildSessionConversationState: vi.fn().mockReturnValue({}),
  getSessionAllowRules: vi.fn().mockReturnValue([]),
  getSessionLoadedCapabilitySlugs: vi.fn().mockReturnValue([]),
}))

vi.mock('./agent-token.service.js', () => ({
  recordTokenUsage: mockRecordTokenUsage,
  checkToolArgSize: vi.fn().mockReturnValue(null),
}))

vi.mock('./agent-conversation-state.js', () => ({
  mergeConversationLoadedCapabilitySlugs: vi.fn().mockReturnValue([]),
  stringArraysEqual: vi.fn().mockReturnValue(true),
  persistConversationLoadedCapabilitySlugs: vi.fn().mockResolvedValue([]),
  buildConversationLoadedCapabilitiesSection: vi.fn().mockReturnValue(''),
}))

vi.mock('./agent-tool-dispatch.js', () => ({
  redactAssistantToolCalls: vi.fn().mockImplementation((tc: unknown) => tc),
  logToolCallSizes: vi.fn(),
  contentOverlapRatio: vi.fn().mockReturnValue(0),
  getEmptyFinalResponseFallback: vi.fn().mockReturnValue('Fallback response'),
  executeToolCalls: mockExecuteToolCalls,
  persistIterationMessage: mockPersistIterationMessage,
}))

import { agentService } from './agent.service.js'
import { deserializeAgentState } from './agent-state.service.js'
import { retryProviderTimeoutOnce } from '../lib/llm-retry.js'

// ── Tests ───────────────────────────────────────────────────────────────

describe('agentService.runAgentLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma = createMockPrisma()
    mockPrisma.chatSession.findUniqueOrThrow.mockResolvedValue({
      id: 'session-1',
      workspaceId: 'ws-1',
      contextSummary: null,
      contextSummaryUpTo: null,
      lastInputTokens: 0,
      sessionAllowRules: null,
    })
    mockPrisma.workspace.findUnique.mockResolvedValue({
      id: 'ws-1',
      permissions: null,
    })
    mockPrisma.document.findMany.mockResolvedValue([])
    mockPrisma.chatMessage.findMany.mockResolvedValue([])
    mockPrisma.chatMessage.create.mockResolvedValue({ id: 'final-msg-1', createdAt: new Date() })

    mockLLM.chatWithTools.mockResolvedValue({
      content: 'Hello, I can help you.',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    })

    mockRecordTokenUsage.mockResolvedValue(undefined)
    mockExecuteToolCalls.mockResolvedValue({ status: 'done', executionIds: [] })
    mockPersistIterationMessage.mockResolvedValue('iter-msg-1')
  })

  test('basic flow: LLM responds with text, no tools', async () => {
    const { emit, events } = createMockSSEEmit()
    const result = await agentService.runAgentLoop('session-1', 'Hello', 'ws-1', emit)

    expect(result.content).toBe('Hello, I can help you.')
    expect(result.paused).toBeUndefined()
    expect(result.toolExecutions).toEqual([])
    expect(events.some((e) => e.event === 'content')).toBe(true)
  })

  test('LLM responds with tool calls, tools execute, loop continues', async () => {
    // First call: LLM responds with tool call
    mockLLM.chatWithTools
      .mockResolvedValueOnce({
        content: 'Let me check...',
        toolCalls: [{ id: 'tc-1', name: 'run_bash', arguments: { command: 'ls' } }],
        finishReason: 'tool_calls',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      })
      // Second call: LLM responds with final text
      .mockResolvedValueOnce({
        content: 'Here are your files.',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 200, outputTokens: 80, totalTokens: 280 },
      })

    const result = await agentService.runAgentLoop('session-1', 'List my files', 'ws-1')

    expect(result.content).toContain('Here are your files.')
    expect(mockLLM.chatWithTools).toHaveBeenCalledTimes(2)
    expect(mockExecuteToolCalls).toHaveBeenCalled()
  })

  test('records token usage after each LLM call', async () => {
    await agentService.runAgentLoop('session-1', 'Hello', 'ws-1')

    expect(mockRecordTokenUsage).toHaveBeenCalledWith(
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      'session-1',
      'mock-provider',
      'mock-model',
    )
  })

  test('SSE events emitted in correct order', async () => {
    const { emit, events } = createMockSSEEmit()
    await agentService.runAgentLoop('session-1', 'Hello', 'ws-1', emit)

    // First event should be 'thinking'
    expect(events[0]).toEqual({ event: 'thinking', data: { message: 'Thinking...' } })
    // Should contain compressing events
    const hasCompressing = events.some((e) => e.event === 'compressing')
    expect(hasCompressing).toBe(true)
    // Should end with content
    const contentEvents = events.filter((e) => e.event === 'content')
    expect(contentEvents.length).toBeGreaterThanOrEqual(1)
  })

  test('returns paused result when tool execution pauses for approval', async () => {
    mockLLM.chatWithTools.mockResolvedValueOnce({
      content: 'I need to run a command.',
      toolCalls: [{ id: 'tc-1', name: 'run_bash', arguments: { command: 'rm -rf /' } }],
      finishReason: 'tool_calls',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    })

    mockExecuteToolCalls.mockResolvedValueOnce({ status: 'paused', executionIds: [] })

    const result = await agentService.runAgentLoop('session-1', 'Delete everything', 'ws-1')

    expect(result.paused).toBe(true)
  })

  test('saves final message to database', async () => {
    await agentService.runAgentLoop('session-1', 'Hello', 'ws-1')

    expect(mockPrisma.chatMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: 'session-1',
        role: 'assistant',
        content: 'Hello, I can help you.',
      }),
    })
  })

  test('LLM timeout triggers retry via retryProviderTimeoutOnce', async () => {
    // retryProviderTimeoutOnce is already mocked to just call the fn
    await agentService.runAgentLoop('session-1', 'Hello', 'ws-1')

    expect(retryProviderTimeoutOnce).toHaveBeenCalled()
  })
})

describe('agentService.resumeAgentLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma = createMockPrisma()
    mockPrisma.chatSession.findUniqueOrThrow.mockResolvedValue({
      id: 'session-1',
      workspaceId: 'ws-1',
      agentState: null,
      agentStateEncrypted: 'encrypted-state',
      agentStatus: 'awaiting_approval',
      sessionAllowRules: null,
    })
    mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
      id: 'ws-1',
      autoExecute: false,
      permissions: null,
    })
    mockPrisma.chatMessage.create.mockResolvedValue({ id: 'resume-msg-1', createdAt: new Date() })
    mockPrisma.chatMessage.findMany.mockResolvedValue([])

    mockLLM.chatWithTools.mockResolvedValue({
      content: 'Task completed.',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 200, outputTokens: 80, totalTokens: 280 },
    })

    mockRecordTokenUsage.mockResolvedValue(undefined)
    mockExecuteToolCalls.mockResolvedValue({ status: 'done', executionIds: [] })
    mockPersistIterationMessage.mockResolvedValue('iter-msg-2')
  })

  test('throws when no agent state to resume', async () => {
    vi.mocked(deserializeAgentState).mockReturnValue(null)

    await expect(agentService.resumeAgentLoop('session-1')).rejects.toThrow(
      'No agent state to resume',
    )
  })

  test('resumes from pending approval with approved tools', async () => {
    vi.mocked(deserializeAgentState).mockReturnValue({
      messages: [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Run something' },
      ],
      iteration: 1,
      pendingToolCalls: [{ id: 'tc-1', name: 'run_bash', arguments: { command: 'ls' } }],
      completedToolResults: [],
      toolExecutionLog: [],
      workspaceId: 'ws-1',
      sessionId: 'session-1',
    })

    mockPrisma.toolApproval.findMany.mockResolvedValue([
      {
        id: 'approval-1',
        toolCallId: 'tc-1',
        toolName: 'run_bash',
        status: 'approved',
        capabilitySlug: 'shell',
      },
    ])

    const result = await agentService.resumeAgentLoop('session-1')

    expect(result.content).toBe('Task completed.')
    expect(result.paused).toBeUndefined()
  })

  test('stops immediately when tool is denied', async () => {
    vi.mocked(deserializeAgentState).mockReturnValue({
      messages: [{ role: 'system', content: 'System' }],
      iteration: 1,
      pendingToolCalls: [{ id: 'tc-1', name: 'run_bash', arguments: { command: 'rm -rf /' } }],
      completedToolResults: [],
      toolExecutionLog: [],
      workspaceId: 'ws-1',
      sessionId: 'session-1',
    })

    mockPrisma.toolApproval.findMany.mockResolvedValue([
      {
        id: 'approval-1',
        toolCallId: 'tc-1',
        toolName: 'run_bash',
        status: 'denied',
        capabilitySlug: 'shell',
      },
    ])

    const { emit } = createMockSSEEmit()
    const result = await agentService.resumeAgentLoop('session-1', emit)

    expect(result.content).toContain('not approved')
  })

  test('throws when pending approvals remain undecided', async () => {
    vi.mocked(deserializeAgentState).mockReturnValue({
      messages: [],
      iteration: 1,
      pendingToolCalls: [{ id: 'tc-1', name: 'run_bash', arguments: {} }],
      completedToolResults: [],
      toolExecutionLog: [],
      workspaceId: 'ws-1',
      sessionId: 'session-1',
    })

    mockPrisma.toolApproval.findMany.mockResolvedValue([
      { id: 'approval-1', toolCallId: 'tc-1', status: 'pending' },
    ])

    await expect(agentService.resumeAgentLoop('session-1')).rejects.toThrow(
      'Not all approvals have been decided',
    )
  })
})

describe('agentService.run', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma = createMockPrisma()
    mockPrisma.chatSession.findFirst.mockResolvedValue(null)
    mockPrisma.chatSession.create.mockResolvedValue({
      id: 'new-session',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    mockPrisma.chatSession.findUniqueOrThrow.mockResolvedValue({
      id: 'new-session',
      workspaceId: 'ws-1',
      contextSummary: null,
      contextSummaryUpTo: null,
      lastInputTokens: 0,
      sessionAllowRules: null,
    })
    mockPrisma.workspace.findUnique.mockResolvedValue({ id: 'ws-1', permissions: null })
    mockPrisma.document.findMany.mockResolvedValue([])
    mockPrisma.chatMessage.findMany.mockResolvedValue([])
    mockPrisma.chatMessage.create.mockResolvedValue({ id: 'msg-1', createdAt: new Date() })

    mockLLM.chatWithTools.mockResolvedValue({
      content: 'Answer',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
    })
    mockRecordTokenUsage.mockResolvedValue(undefined)
  })

  test('creates session if none exists and returns answer', async () => {
    const result = await agentService.run('What is 2+2?', { workspaceId: 'ws-1' })

    expect(result.answer).toBe('Answer')
    expect(mockPrisma.chatSession.create).toHaveBeenCalled()
  })

  test('reuses existing __agent_session__', async () => {
    mockPrisma.chatSession.findFirst.mockResolvedValue({
      id: 'existing-session',
      workspaceId: 'ws-1',
    })
    mockPrisma.chatSession.findUniqueOrThrow.mockResolvedValue({
      id: 'existing-session',
      workspaceId: 'ws-1',
      contextSummary: null,
      contextSummaryUpTo: null,
      lastInputTokens: 0,
      sessionAllowRules: null,
    })

    await agentService.run('Hello', { workspaceId: 'ws-1' })

    expect(mockPrisma.chatSession.create).not.toHaveBeenCalled()
  })
})
