import { describe, expect, test, vi, beforeEach } from 'vitest'
import { createMockPrisma, type MockPrisma } from '@test/factories/prisma'
import { createMockLLMProvider } from '@test/factories/llm'

// ── Mocks ───────────────────────────────────────────────────────────────

let mockPrisma: MockPrisma

vi.mock('@prisma/client', () => ({
  Prisma: {
    join: vi.fn().mockReturnValue('mock-join'),
    sql: vi.fn().mockReturnValue('mock-sql'),
  },
}))

vi.mock('../lib/prisma.js', () => ({
  get prisma() {
    return mockPrisma
  },
}))

const mockExecuteLLM = createMockLLMProvider({ response: { content: 'Mock response' } })
const mockTitleLLM = createMockLLMProvider({ response: { content: 'Mock Title' } })

const mockCreateTitleLLM = vi.fn().mockResolvedValue(mockTitleLLM)

vi.mock('../providers/index.js', () => ({
  createExecuteLLM: vi.fn().mockResolvedValue(mockExecuteLLM),
  createTitleLLM: mockCreateTitleLLM,
}))

vi.mock('./agent-token.service.js', () => ({
  recordTokenUsage: vi.fn(),
}))

vi.mock('./embedding.service.js', () => ({
  embeddingService: {
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  },
}))

vi.mock('./search.service.js', () => ({
  searchService: {
    search: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('./agent.service.js', () => ({
  agentService: {
    runAgentLoop: vi.fn().mockResolvedValue({ lastMessageId: 'msg-1', paused: false }),
  },
}))

vi.mock('./capability.service.js', () => ({
  capabilityService: {
    getEnabledCapabilitiesForWorkspace: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('./secret-redaction.service.js', () => ({
  secretRedactionService: {
    buildSecretInventory: vi.fn().mockResolvedValue({ enabled: false }),
    redactForPublicStorage: vi.fn().mockImplementation((text: string) => text),
  },
}))

vi.mock('../lib/sse.js', () => ({}))

vi.mock('../lib/agent-abort.js', () => ({
  registerAgentLoop: vi.fn().mockReturnValue(new AbortController()),
  unregisterAgentLoop: vi.fn(),
  isAbortError: vi.fn().mockReturnValue(false),
}))

vi.mock('../lib/llm-retry.js', () => ({
  getProviderErrorMessage: vi.fn().mockImplementation((err: unknown) => {
    if (err instanceof Error) return err.message
    return String(err ?? 'An unexpected error occurred')
  }),
}))

vi.mock('../lib/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// ── Import SUT after mocks ──────────────────────────────────────────────

const { chatService } = await import('./chat.service.js')

// ── Helpers ─────────────────────────────────────────────────────────────

function createMockEmit(): ReturnType<typeof vi.fn> {
  return vi.fn()
}

// ── Tests ───────────────────────────────────────────────────────────────

beforeEach(() => {
  mockPrisma = createMockPrisma()
  vi.clearAllMocks()
})

// ── Session management ──────────────────────────────────────────────────

describe('chatService.createSession', () => {
  test('creates a session with workspaceId and title', async () => {
    const data = { workspaceId: 'ws-1', title: 'My Chat' }
    const created = { id: 'sess-1', ...data, createdAt: new Date(), updatedAt: new Date() }
    mockPrisma.chatSession.create.mockResolvedValue(created)

    const result = await chatService.createSession(data)

    expect(mockPrisma.chatSession.create).toHaveBeenCalledWith({ data })
    expect(result).toEqual(created)
  })

  test('creates a session without title', async () => {
    const data = { workspaceId: 'ws-1' }
    mockPrisma.chatSession.create.mockResolvedValue({ id: 'sess-2', ...data })

    const result = await chatService.createSession(data)

    expect(mockPrisma.chatSession.create).toHaveBeenCalledWith({ data })
    expect(result.id).toBe('sess-2')
  })

  test('propagates DB failure during session creation', async () => {
    mockPrisma.chatSession.create.mockRejectedValue(new Error('DB connection lost'))

    await expect(chatService.createSession({ workspaceId: 'ws-1' })).rejects.toThrow(
      'DB connection lost',
    )
  })
})

describe('chatService.getSession', () => {
  test('returns session when it exists', async () => {
    const session = { id: 'sess-1', workspaceId: 'ws-1', title: 'Test' }
    mockPrisma.chatSession.findUnique.mockResolvedValue(session)

    const result = await chatService.getSession('sess-1')

    expect(mockPrisma.chatSession.findUnique).toHaveBeenCalledWith({ where: { id: 'sess-1' } })
    expect(result).toEqual(session)
  })

  test('returns null when session does not exist', async () => {
    mockPrisma.chatSession.findUnique.mockResolvedValue(null)

    const result = await chatService.getSession('nonexistent')

    expect(result).toBeNull()
  })
})

describe('chatService.listSessions', () => {
  test('returns empty array when no sessions exist', async () => {
    mockPrisma.chatSession.findMany.mockResolvedValue([])

    const result = await chatService.listSessions()

    expect(result).toEqual([])
  })

  test('returns sessions with unreadCount and activeSandbox', async () => {
    const now = new Date()
    const sessions = [
      { id: 'sess-1', lastMessageAt: now, lastReadAt: null, updatedAt: now },
      { id: 'sess-2', lastMessageAt: now, lastReadAt: now, updatedAt: now },
    ]
    mockPrisma.chatSession.findMany.mockResolvedValue(sessions)
    mockPrisma.$queryRaw.mockResolvedValue([{ sessionId: 'sess-1', count: BigInt(3) }])
    mockPrisma.sandboxSession.groupBy.mockResolvedValue([
      { chatSessionId: 'sess-1', _count: { id: 1 } },
    ])

    const result = await chatService.listSessions()

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ id: 'sess-1', unreadCount: 3, activeSandbox: true })
    expect(result[1]).toMatchObject({ id: 'sess-2', unreadCount: 0, activeSandbox: false })
  })
})

describe('chatService.deleteSession', () => {
  test('deletes a session by id', async () => {
    mockPrisma.chatSession.delete.mockResolvedValue({ id: 'sess-1' })

    const result = await chatService.deleteSession('sess-1')

    expect(mockPrisma.chatSession.delete).toHaveBeenCalledWith({ where: { id: 'sess-1' } })
    expect(result).toEqual({ id: 'sess-1' })
  })
})

describe('chatService.markAsRead', () => {
  test('executes raw SQL to update lastReadAt', async () => {
    mockPrisma.$executeRaw.mockResolvedValue(1)

    await chatService.markAsRead('sess-1')

    expect(mockPrisma.$executeRaw).toHaveBeenCalled()
  })
})

// ── Message persistence ─────────────────────────────────────────────────

describe('chatService.getMessages', () => {
  test('returns messages ordered by createdAt asc', async () => {
    const messages = [
      {
        id: 'msg-1',
        sessionId: 'sess-1',
        role: 'user',
        content: 'Hello',
        toolCalls: null,
        contentBlocks: null,
        toolExecutions: [],
        createdAt: new Date('2024-01-01T00:00:00Z'),
      },
      {
        id: 'msg-2',
        sessionId: 'sess-1',
        role: 'assistant',
        content: 'Hi there',
        toolCalls: null,
        contentBlocks: null,
        toolExecutions: [],
        createdAt: new Date('2024-01-01T00:01:00Z'),
      },
    ]
    mockPrisma.chatMessage.findMany.mockResolvedValue(messages)

    const result = await chatService.getMessages('sess-1')

    expect(mockPrisma.chatMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionId: 'sess-1' },
        orderBy: { createdAt: 'asc' },
      }),
    )
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('msg-1')
    expect(result[1].id).toBe('msg-2')
  })

  test('reconstructs contentBlocks from stored layout', async () => {
    const messages = [
      {
        id: 'msg-1',
        sessionId: 'sess-1',
        role: 'assistant',
        content: 'Hello',
        toolCalls: null,
        contentBlocks: [
          { type: 'text', text: 'Here is the result' },
          { type: 'tool', toolIndex: 0 },
        ],
        toolExecutions: [
          {
            id: 'te-1',
            toolName: 'run_bash',
            capabilitySlug: 'sandbox',
            input: { command: 'ls' },
            output: 'file.txt',
            screenshot: null,
            error: null,
            exitCode: 0,
            durationMs: 100,
            status: 'completed',
          },
        ],
        createdAt: new Date(),
      },
    ]
    mockPrisma.chatMessage.findMany.mockResolvedValue(messages)

    const result = await chatService.getMessages('sess-1')

    expect(result[0].contentBlocks).toBeDefined()
    expect(result[0].contentBlocks).toHaveLength(2)
    expect(result[0].contentBlocks![0]).toEqual({ type: 'text', text: 'Here is the result' })
    expect(result[0].contentBlocks![1]).toMatchObject({ type: 'tool', tool: { id: 'te-1' } })
  })

  test('falls back to toolCalls JSON when no linked toolExecutions', async () => {
    const messages = [
      {
        id: 'msg-1',
        sessionId: 'sess-1',
        role: 'assistant',
        content: '',
        toolCalls: [
          { name: 'run_bash', capability: 'sandbox', input: { cmd: 'ls' }, output: 'ok' },
        ],
        contentBlocks: null,
        toolExecutions: [],
        createdAt: new Date(),
      },
    ]
    mockPrisma.chatMessage.findMany.mockResolvedValue(messages)

    const result = await chatService.getMessages('sess-1')

    expect(result[0].toolExecutions).toHaveLength(1)
    expect(result[0].toolExecutions[0].toolName).toBe('run_bash')
    expect(result[0].toolExecutions[0].output).toBe('ok')
  })

  test('loads sub-agent tool executions from stored IDs', async () => {
    const messages = [
      {
        id: 'msg-1',
        sessionId: 'sess-1',
        role: 'assistant',
        content: '',
        toolCalls: null,
        contentBlocks: [
          {
            type: 'sub_agent',
            toolIndex: 0,
            subAgentId: 'sa-1',
            role: 'execute',
            task: 'Do something',
            subToolIds: ['sub-te-1'],
          },
        ],
        toolExecutions: [
          {
            id: 'te-main',
            toolName: 'delegate_task',
            capabilitySlug: '',
            input: {},
            output: 'Done',
            screenshot: null,
            error: null,
            exitCode: null,
            durationMs: 500,
            status: 'completed',
          },
        ],
        createdAt: new Date(),
      },
    ]
    mockPrisma.chatMessage.findMany.mockResolvedValue(messages)
    mockPrisma.toolExecution.findMany.mockResolvedValue([
      {
        id: 'sub-te-1',
        toolName: 'run_bash',
        capabilitySlug: 'sandbox',
        input: {},
        output: 'sub output',
        screenshot: null,
        error: null,
        exitCode: 0,
        durationMs: 50,
        status: 'completed',
      },
    ])

    const result = await chatService.getMessages('sess-1')

    expect(mockPrisma.toolExecution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['sub-te-1'] } } }),
    )
    const block = result[0].contentBlocks![0] as { type: string; subAgent: { tools: unknown[] } }
    expect(block.type).toBe('sub_agent')
    expect(block.subAgent.tools).toHaveLength(1)
  })
})

// ── persistAssistantErrorMessage ────────────────────────────────────────

describe('chatService.persistAssistantErrorMessage', () => {
  test('persists error message as assistant role', async () => {
    const msg = { id: 'msg-err', role: 'assistant', content: 'Error: something failed' }
    mockPrisma.chatMessage.create.mockResolvedValue(msg)

    const result = await chatService.persistAssistantErrorMessage(
      'sess-1',
      new Error('something failed'),
    )

    expect(mockPrisma.chatMessage.create).toHaveBeenCalledWith({
      data: {
        sessionId: 'sess-1',
        role: 'assistant',
        content: 'Error: something failed',
      },
    })
    expect(result).toEqual(msg)
  })

  test('returns null when DB fails during persist', async () => {
    mockPrisma.chatMessage.create.mockRejectedValue(new Error('DB write failed'))

    const result = await chatService.persistAssistantErrorMessage(
      'sess-1',
      new Error('original error'),
    )

    expect(result).toBeNull()
  })
})

describe('chatService.formatAssistantErrorMessage', () => {
  test('formats error using provider error message', () => {
    const result = chatService.formatAssistantErrorMessage(new Error('Rate limited'))
    expect(result).toBe('Error: Rate limited')
  })
})

// ── Auto-titling ────────────────────────────────────────────────────────

describe('chatService._autoTitle', () => {
  test('does nothing when session already has a title', () => {
    chatService._autoTitle({ title: 'Existing Title' }, 'sess-1', 'Hello')

    // createTitleLLM should not be called since title exists
    expect(mockCreateTitleLLM).not.toHaveBeenCalled()
  })

  test('generates title for untitled session', async () => {
    mockTitleLLM.chatWithTools.mockResolvedValue({
      content: '  Generated Title  ',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    })
    mockPrisma.$executeRaw.mockResolvedValue(1)

    chatService._autoTitle({ title: null }, 'sess-1', 'What is TypeScript?')

    // Wait for the promise chain to resolve
    await vi.waitFor(() => {
      expect(mockPrisma.$executeRaw).toHaveBeenCalled()
    })
  })

  test('falls back to content snippet when title generation fails', async () => {
    mockTitleLLM.chatWithTools.mockRejectedValue(new Error('LLM unavailable'))
    mockPrisma.$executeRaw.mockResolvedValue(1)

    chatService._autoTitle({ title: null }, 'sess-1', 'Short question')

    await vi.waitFor(() => {
      // Should have been called with fallback title
      expect(mockPrisma.$executeRaw).toHaveBeenCalled()
    })
  })

  test('title not re-generated on subsequent messages', () => {
    chatService._autoTitle({ title: 'Already Set' }, 'sess-1', 'Another message')

    expect(mockCreateTitleLLM).not.toHaveBeenCalled()
  })
})

// ── sendMessage ─────────────────────────────────────────────────────────

describe('chatService.sendMessage', () => {
  const sessionId = 'sess-1'
  const workspaceId = 'ws-1'

  beforeEach(() => {
    mockPrisma.chatSession.findUniqueOrThrow.mockResolvedValue({
      id: sessionId,
      workspaceId,
      title: null,
    })
  })

  test('persists user message and bumps lastMessageAt', async () => {
    const emit = createMockEmit()
    const { capabilityService } = await import('./capability.service.js')
    vi.mocked(capabilityService.getEnabledCapabilitiesForWorkspace).mockResolvedValue([])

    // RAG path with no search results
    mockPrisma.chatMessage.create.mockResolvedValue({ id: 'msg-assistant', role: 'assistant' })

    await chatService.sendMessage(sessionId, 'Hello', emit)

    // User message creation
    expect(mockPrisma.chatMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sessionId,
          role: 'user',
          content: 'Hello',
        }),
      }),
    )
    // lastMessageAt bump
    expect(mockPrisma.$executeRaw).toHaveBeenCalled()
  })

  test('routes to agent loop when non-doc capabilities exist', async () => {
    const emit = createMockEmit()
    const { capabilityService } = await import('./capability.service.js')
    vi.mocked(capabilityService.getEnabledCapabilitiesForWorkspace).mockResolvedValue([
      { slug: 'sandbox', id: 'cap-1', name: 'Sandbox' },
    ] as any)

    const { agentService } = await import('./agent.service.js')
    vi.mocked(agentService.runAgentLoop).mockResolvedValue({
      lastMessageId: 'msg-agent',
      paused: false,
    })

    mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({ autoExecute: true })

    await chatService.sendMessage(sessionId, 'Run a script', emit)

    expect(agentService.runAgentLoop).toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith('done', expect.objectContaining({ sessionId }))
  })

  test('routes to agent loop when mentions are present', async () => {
    const emit = createMockEmit()
    const { capabilityService } = await import('./capability.service.js')
    vi.mocked(capabilityService.getEnabledCapabilitiesForWorkspace).mockResolvedValue([])

    const { agentService } = await import('./agent.service.js')
    vi.mocked(agentService.runAgentLoop).mockResolvedValue({
      lastMessageId: 'msg-agent',
      paused: false,
    })

    mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({ autoExecute: false })

    await chatService.sendMessage(sessionId, 'Hello', emit, { mentionedSlugs: ['sandbox'] })

    expect(agentService.runAgentLoop).toHaveBeenCalled()
  })

  test('routes to RAG when only document-search capability exists', async () => {
    const emit = createMockEmit()
    const { capabilityService } = await import('./capability.service.js')
    vi.mocked(capabilityService.getEnabledCapabilitiesForWorkspace).mockResolvedValue([
      { slug: 'document-search', id: 'cap-doc', name: 'Doc Search' },
    ] as any)

    mockPrisma.chatMessage.create.mockResolvedValue({ id: 'msg-rag', role: 'assistant' })

    await chatService.sendMessage(sessionId, 'Search docs', emit)

    expect(emit).toHaveBeenCalledWith('thinking', { message: 'Searching documents...' })
    expect(emit).toHaveBeenCalledWith('done', expect.objectContaining({ messageId: 'msg-rag' }))
  })
})

// ── _sendWithRAG ────────────────────────────────────────────────────────

describe('chatService._sendWithRAG', () => {
  const session = { id: 'sess-1', workspaceId: 'ws-1', title: null }
  const inventory = { enabled: false } as any

  test('emits sources when chunks are found', async () => {
    const emit = createMockEmit()
    const { searchService } = await import('./search.service.js')
    vi.mocked(searchService.search).mockResolvedValue([
      { id: 'q1', score: 0.9, payload: { chunkId: 'chunk-1' } },
      { id: 'q2', score: 0.8, payload: { chunkId: 'chunk-2' } },
    ] as any)

    mockPrisma.documentChunk.findMany.mockResolvedValue([
      {
        id: 'chunk-1',
        chunkIndex: 0,
        content: 'Content 1',
        document: { id: 'doc-1', title: 'Doc One' },
      },
      {
        id: 'chunk-2',
        chunkIndex: 1,
        content: 'Content 2',
        document: { id: 'doc-2', title: 'Doc Two' },
      },
    ])

    mockPrisma.chatMessage.create.mockResolvedValue({ id: 'msg-1' })

    await chatService._sendWithRAG(session, 'sess-1', 'question', emit, inventory)

    expect(emit).toHaveBeenCalledWith('sources', {
      sources: expect.arrayContaining([
        expect.objectContaining({ documentId: 'doc-1', documentTitle: 'Doc One' }),
        expect.objectContaining({ documentId: 'doc-2', documentTitle: 'Doc Two' }),
      ]),
    })
  })

  test('deduplicates sources by document ID', async () => {
    const emit = createMockEmit()
    const { searchService } = await import('./search.service.js')
    vi.mocked(searchService.search).mockResolvedValue([
      { id: 'q1', score: 0.9, payload: { chunkId: 'chunk-1' } },
      { id: 'q2', score: 0.8, payload: { chunkId: 'chunk-2' } },
    ] as any)

    // Both chunks from the same document
    mockPrisma.documentChunk.findMany.mockResolvedValue([
      {
        id: 'chunk-1',
        chunkIndex: 0,
        content: 'Part 1',
        document: { id: 'doc-1', title: 'Doc One' },
      },
      {
        id: 'chunk-2',
        chunkIndex: 1,
        content: 'Part 2',
        document: { id: 'doc-1', title: 'Doc One' },
      },
    ])

    mockPrisma.chatMessage.create.mockResolvedValue({ id: 'msg-1' })

    await chatService._sendWithRAG(session, 'sess-1', 'question', emit, inventory)

    const sourcesCall = emit.mock.calls.find((c: unknown[]) => c[0] === 'sources')
    expect(sourcesCall).toBeDefined()
    expect(sourcesCall![1].sources).toHaveLength(1)
    expect(sourcesCall![1].sources[0].documentId).toBe('doc-1')
  })

  test('does not emit sources when no chunks found', async () => {
    const emit = createMockEmit()
    const { searchService } = await import('./search.service.js')
    vi.mocked(searchService.search).mockResolvedValue([])
    mockPrisma.chatMessage.create.mockResolvedValue({ id: 'msg-1' })

    await chatService._sendWithRAG(session, 'sess-1', 'question', emit, inventory)

    const sourcesCall = emit.mock.calls.find((c: unknown[]) => c[0] === 'sources')
    expect(sourcesCall).toBeUndefined()
  })

  test('persists assistant message with sources', async () => {
    const emit = createMockEmit()
    const { searchService } = await import('./search.service.js')
    vi.mocked(searchService.search).mockResolvedValue([
      { id: 'q1', score: 0.9, payload: { chunkId: 'chunk-1' } },
    ] as any)

    mockPrisma.documentChunk.findMany.mockResolvedValue([
      {
        id: 'chunk-1',
        chunkIndex: 0,
        content: 'Content',
        document: { id: 'doc-1', title: 'Doc' },
      },
    ])
    mockPrisma.chatMessage.create.mockResolvedValue({ id: 'msg-1' })

    await chatService._sendWithRAG(session, 'sess-1', 'question', emit, inventory)

    expect(mockPrisma.chatMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: 'sess-1',
        role: 'assistant',
        sources: expect.arrayContaining([expect.objectContaining({ documentId: 'doc-1' })]),
      }),
    })
  })
})

// ── _sendWithAgentLoop ──────────────────────────────────────────────────

describe('chatService._sendWithAgentLoop', () => {
  const session = { id: 'sess-1', workspaceId: 'ws-1', title: 'Existing' }
  const inventory = { enabled: false } as any

  test('sets agentStatus to running then idle on success', async () => {
    const emit = createMockEmit()
    const { agentService } = await import('./agent.service.js')
    vi.mocked(agentService.runAgentLoop).mockResolvedValue({
      lastMessageId: 'msg-1',
      paused: false,
    })
    mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({ autoExecute: false })

    await chatService._sendWithAgentLoop(session, 'sess-1', 'Do it', emit, inventory)

    // First update: running
    expect(mockPrisma.chatSession.update).toHaveBeenCalledWith({
      where: { id: 'sess-1' },
      data: { agentStatus: 'running' },
    })
    // Second update: idle
    expect(mockPrisma.chatSession.update).toHaveBeenCalledWith({
      where: { id: 'sess-1' },
      data: { agentStatus: 'idle' },
    })
    expect(emit).toHaveBeenCalledWith('done', { messageId: 'msg-1', sessionId: 'sess-1' })
  })

  test('does not emit done when agent is paused', async () => {
    const emit = createMockEmit()
    const { agentService } = await import('./agent.service.js')
    vi.mocked(agentService.runAgentLoop).mockResolvedValue({
      lastMessageId: 'msg-1',
      paused: true,
    })
    mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({ autoExecute: false })

    await chatService._sendWithAgentLoop(session, 'sess-1', 'Do it', emit, inventory)

    // Should NOT set idle or emit done when paused
    const idleUpdate = mockPrisma.chatSession.update.mock.calls.find(
      (c: unknown[]) => (c[0] as any).data?.agentStatus === 'idle',
    )
    expect(idleUpdate).toBeUndefined()
    expect(emit).not.toHaveBeenCalledWith('done', expect.anything())
  })

  test('handles abort error gracefully', async () => {
    const emit = createMockEmit()
    const { agentService } = await import('./agent.service.js')
    const abortErr = new DOMException('Aborted', 'AbortError')
    vi.mocked(agentService.runAgentLoop).mockRejectedValue(abortErr)

    const { isAbortError } = await import('../lib/agent-abort.js')
    vi.mocked(isAbortError).mockReturnValue(true)

    mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({ autoExecute: false })

    await chatService._sendWithAgentLoop(session, 'sess-1', 'Do it', emit, inventory)

    expect(emit).toHaveBeenCalledWith('aborted', { sessionId: 'sess-1' })
    expect(emit).toHaveBeenCalledWith('done', { sessionId: 'sess-1' })
  })

  test('persists error message and emits error on agent failure', async () => {
    const emit = createMockEmit()
    const { agentService } = await import('./agent.service.js')
    vi.mocked(agentService.runAgentLoop).mockRejectedValue(new Error('Agent crashed'))

    const { isAbortError } = await import('../lib/agent-abort.js')
    vi.mocked(isAbortError).mockReturnValue(false)

    mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({ autoExecute: false })
    mockPrisma.chatMessage.create.mockResolvedValue({ id: 'err-msg-1' })

    await chatService._sendWithAgentLoop(session, 'sess-1', 'Do it', emit, inventory)

    expect(emit).toHaveBeenCalledWith('error', { message: 'Agent crashed' })
    expect(emit).toHaveBeenCalledWith(
      'done',
      expect.objectContaining({ sessionId: 'sess-1', messageId: 'err-msg-1' }),
    )
  })

  test('always unregisters agent loop in finally block', async () => {
    const emit = createMockEmit()
    const { agentService } = await import('./agent.service.js')
    vi.mocked(agentService.runAgentLoop).mockRejectedValue(new Error('fail'))

    const { isAbortError, unregisterAgentLoop } = await import('../lib/agent-abort.js')
    vi.mocked(isAbortError).mockReturnValue(false)

    mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({ autoExecute: false })

    await chatService._sendWithAgentLoop(session, 'sess-1', 'Do it', emit, inventory)

    expect(unregisterAgentLoop).toHaveBeenCalledWith('sess-1')
  })
})

// ── Error scenarios ─────────────────────────────────────────────────────

describe('error scenarios', () => {
  test('DB failure during message persistence in getMessages', async () => {
    mockPrisma.chatMessage.findMany.mockRejectedValue(new Error('DB read failed'))

    await expect(chatService.getMessages('sess-1')).rejects.toThrow('DB read failed')
  })

  test('DB failure during session deletion', async () => {
    mockPrisma.chatSession.delete.mockRejectedValue(new Error('FK constraint'))

    await expect(chatService.deleteSession('sess-1')).rejects.toThrow('FK constraint')
  })
})
