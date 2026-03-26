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
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../constants.js', () => ({
  TOOL_ARG_SIZE_LIMIT: 10_000,
}))

import { checkToolArgSize, recordTokenUsage } from './agent-token.service.js'

// ── Tests ───────────────────────────────────────────────────────────────

describe('checkToolArgSize', () => {
  test('returns null when args are under the limit', () => {
    const result = checkToolArgSize({
      name: 'run_bash',
      arguments: { command: 'ls -la' },
    })
    expect(result).toBeNull()
  })

  test('returns rejection message when command arg exceeds limit', () => {
    const result = checkToolArgSize({
      name: 'run_bash',
      arguments: { command: 'x'.repeat(11_000) },
    })
    expect(result).toContain('[BLOCKED]')
    expect(result).toContain('run_bash')
    expect(result).toContain('11KB')
  })

  test('checks code argument as well', () => {
    const result = checkToolArgSize({
      name: 'run_python',
      arguments: { code: 'x'.repeat(15_000) },
    })
    expect(result).toContain('[BLOCKED]')
  })

  test('checks content argument as well', () => {
    const result = checkToolArgSize({
      name: 'some_tool',
      arguments: { content: 'x'.repeat(12_000) },
    })
    expect(result).toContain('[BLOCKED]')
  })

  test('returns null for exempt tools (generate_file)', () => {
    const result = checkToolArgSize({
      name: 'generate_file',
      arguments: { content: 'x'.repeat(20_000) },
    })
    expect(result).toBeNull()
  })

  test('returns null for exempt tools (save_document)', () => {
    const result = checkToolArgSize({
      name: 'save_document',
      arguments: { content: 'x'.repeat(20_000) },
    })
    expect(result).toBeNull()
  })

  test('returns null for exempt tools (search_documents)', () => {
    const result = checkToolArgSize({
      name: 'search_documents',
      arguments: { content: 'x'.repeat(20_000) },
    })
    expect(result).toBeNull()
  })

  test('returns null when args have no command/code/content key', () => {
    const result = checkToolArgSize({
      name: 'run_bash',
      arguments: { path: '/some/very/long/' + 'x'.repeat(20_000) },
    })
    expect(result).toBeNull()
  })

  test('returns null when commandArg is not a string', () => {
    const result = checkToolArgSize({
      name: 'run_bash',
      arguments: { command: 12345 },
    })
    expect(result).toBeNull()
  })

  test('returns null when arguments is empty', () => {
    const result = checkToolArgSize({
      name: 'run_bash',
      arguments: {},
    })
    expect(result).toBeNull()
  })
})

describe('recordTokenUsage', () => {
  beforeEach(() => {
    mockPrisma = createMockPrisma()
  })

  test('records usage correctly with all fields', async () => {
    await recordTokenUsage(
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      'session-1',
      'openai',
      'gpt-4o',
    )

    expect(mockPrisma.tokenUsage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        sessionId: 'session-1',
      }),
    })
  })

  test('updates session lastInputTokens by default', async () => {
    await recordTokenUsage(
      { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
      'session-2',
      'anthropic',
      'claude-3',
    )

    expect(mockPrisma.chatSession.update).toHaveBeenCalledWith({
      where: { id: 'session-2' },
      data: { lastInputTokens: 200 },
    })
  })

  test('skips session update when updateSessionContext is false', async () => {
    await recordTokenUsage(
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      'session-1',
      'openai',
      'gpt-4o',
      { updateSessionContext: false },
    )

    expect(mockPrisma.chatSession.update).not.toHaveBeenCalled()
  })

  test('handles zero tokens', async () => {
    await recordTokenUsage(
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      'session-1',
      'openai',
      'gpt-4o',
    )

    expect(mockPrisma.tokenUsage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }),
    })
  })

  test('does nothing when usage is undefined', async () => {
    await recordTokenUsage(undefined, 'session-1', 'openai', 'gpt-4o')

    expect(mockPrisma.tokenUsage.create).not.toHaveBeenCalled()
    expect(mockPrisma.chatSession.update).not.toHaveBeenCalled()
  })

  test('catches and logs DB failure without throwing', async () => {
    mockPrisma.tokenUsage.create.mockRejectedValue(new Error('DB write failed'))

    await expect(
      recordTokenUsage(
        { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        'session-1',
        'openai',
        'gpt-4o',
      ),
    ).resolves.toBeUndefined()
  })
})
