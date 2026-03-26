import { describe, expect, test, vi, beforeEach } from 'vitest'

// ── Mocks ───────────────────────────────────────────────────────────────

const mockLLM = {
  providerId: 'mock-provider',
  modelId: 'mock-model',
  chatWithTools: vi.fn().mockResolvedValue({
    content: '## Summary\nCompressed context',
    usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
  }),
}

vi.mock('../providers/index.js', () => ({
  createCompactLLM: vi.fn().mockImplementation(() => Promise.resolve(mockLLM)),
}))

vi.mock('./agent-token.service.js', () => ({
  recordTokenUsage: vi.fn(),
}))

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../constants.js', () => ({
  DEFAULT_MAX_CONTEXT_TOKENS: 1000,
  RECENT_MESSAGES_TO_KEEP: 4,
  MIN_MESSAGES_FOR_COMPRESSION: 6,
  TOKEN_ESTIMATION_DIVISOR: 4,
  COMPRESSION_PREVIEW_LEN: 200,
  COMPRESSION_TEMPERATURE: 0.2,
  COMPRESSION_MAX_TOKENS: 2048,
}))

import { compressContext } from './context-compression.service.js'

// ── Helpers ─────────────────────────────────────────────────────────────

function makeMsg(
  id: string,
  role: string,
  content: string,
  toolCalls?: unknown,
): { id: string; role: string; content: string; toolCalls?: unknown; createdAt: Date } {
  return { id, role, content, toolCalls, createdAt: new Date() }
}

describe('context-compression.service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Edge case: empty history ──────────────────────────────────────────

  test('returns unchanged result for empty history', async () => {
    const result = await compressContext([], null, null, null)
    expect(result.compressed).toBe(false)
    expect(result.recentMessages).toEqual([])
    expect(result.summary).toBeNull()
    expect(result.lastSummarizedMessageId).toBeNull()
  })

  // ── Edge case: single message ─────────────────────────────────────────

  test('returns unchanged result for single message', async () => {
    const history = [makeMsg('1', 'user', 'Hello')]
    const result = await compressContext(history, null, null, null)
    expect(result.compressed).toBe(false)
    expect(result.recentMessages).toHaveLength(1)
  })

  // ── Below MIN_MESSAGES_FOR_COMPRESSION ────────────────────────────────

  test('skips compression when history has fewer than MIN_MESSAGES_FOR_COMPRESSION messages', async () => {
    const history = Array.from({ length: 5 }, (_, i) =>
      makeMsg(`${i}`, i % 2 === 0 ? 'user' : 'assistant', 'short'),
    )
    const result = await compressContext(history, null, null, null)
    expect(result.compressed).toBe(false)
    expect(result.recentMessages).toEqual(history)
  })

  // ── Under token limit ─────────────────────────────────────────────────

  test('skips compression when estimated tokens are under the limit', async () => {
    // 6 messages, each 8 chars => ~2 tokens each => 12 total, well under 1000
    const history = Array.from({ length: 6 }, (_, i) =>
      makeMsg(`${i}`, i % 2 === 0 ? 'user' : 'assistant', 'short!!'),
    )
    const result = await compressContext(history, null, null, null)
    expect(result.compressed).toBe(false)
    expect(result.recentMessages).toEqual(history)
  })

  // ── Compression triggers with long messages ───────────────────────────

  test('compresses when estimated tokens exceed the limit', async () => {
    // 8 messages with 600 chars each => ~150 tokens each => ~1200 total, over 1000
    const longContent = 'x'.repeat(600)
    const history = Array.from({ length: 8 }, (_, i) =>
      makeMsg(`msg-${i}`, i % 2 === 0 ? 'user' : 'assistant', longContent),
    )

    const result = await compressContext(history, null, null, null)
    expect(result.compressed).toBe(true)
    expect(result.summary).toBe('## Summary\nCompressed context')
    expect(result.lastSummarizedMessageId).toBeTruthy()
    expect(result.recentMessages.length).toBeLessThan(history.length)
    expect(mockLLM.chatWithTools).toHaveBeenCalledOnce()
  })

  // ── Compression triggers via lastInputTokens ─────────────────────────

  test('compresses when lastInputTokens exceeds limit even if estimated tokens are low', async () => {
    const history = Array.from({ length: 8 }, (_, i) =>
      makeMsg(`msg-${i}`, i % 2 === 0 ? 'user' : 'assistant', 'short msg'),
    )

    const result = await compressContext(history, null, null, 5000)
    expect(result.compressed).toBe(true)
    expect(mockLLM.chatWithTools).toHaveBeenCalledOnce()
  })

  // ── Already summarized up to the same point ───────────────────────────

  test('reuses existing summary when already summarized up to the same point', async () => {
    const longContent = 'x'.repeat(600)
    const history = Array.from({ length: 8 }, (_, i) =>
      makeMsg(`msg-${i}`, i % 2 === 0 ? 'user' : 'assistant', longContent),
    )

    // First compression to find the lastSummarizedMessageId
    const firstResult = await compressContext(history, null, null, null)
    expect(firstResult.compressed).toBe(true)
    const summaryId = firstResult.lastSummarizedMessageId!

    vi.clearAllMocks()

    // Second call with existing summary up to that point
    const result = await compressContext(history, 'Existing summary', summaryId, null)
    expect(result.compressed).toBe(false)
    expect(result.summary).toBe('Existing summary')
    expect(mockLLM.chatWithTools).not.toHaveBeenCalled()
  })

  // ── Custom maxContextTokens ───────────────────────────────────────────

  test('respects custom maxContextTokens parameter', async () => {
    const history = Array.from({ length: 8 }, (_, i) =>
      makeMsg(`msg-${i}`, i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(100)),
    )
    // 8 * 25 tokens = 200, set limit to 50 to force compression
    const result = await compressContext(history, null, null, null, undefined, 50)
    expect(result.compressed).toBe(true)
  })

  // ── Tool-call group safety ────────────────────────────────────────────

  test('does not split inside a tool-call group', async () => {
    const longContent = 'x'.repeat(600)
    const history = [
      makeMsg('1', 'user', longContent),
      makeMsg('2', 'assistant', longContent, [{ id: 'tc1', name: 'test' }]),
      makeMsg('3', 'tool', longContent),
      makeMsg('4', 'tool', longContent),
      makeMsg('5', 'assistant', longContent),
      makeMsg('6', 'user', longContent),
      makeMsg('7', 'assistant', longContent),
      makeMsg('8', 'user', longContent),
    ]

    const result = await compressContext(history, null, null, null)
    // Recent messages should not start with a 'tool' message
    if (result.compressed) {
      expect(result.recentMessages[0].role).not.toBe('tool')
    }
  })

  // ── LLM failure falls back gracefully ─────────────────────────────────

  test('returns full history when LLM compression fails', async () => {
    mockLLM.chatWithTools.mockRejectedValueOnce(new Error('LLM unavailable'))

    const longContent = 'x'.repeat(600)
    const history = Array.from({ length: 8 }, (_, i) =>
      makeMsg(`msg-${i}`, i % 2 === 0 ? 'user' : 'assistant', longContent),
    )

    const result = await compressContext(history, 'prev-summary', null, null)
    expect(result.compressed).toBe(false)
    expect(result.summary).toBe('prev-summary')
    expect(result.recentMessages).toEqual(history)
    expect(result.lastSummarizedMessageId).toBeNull()
  })

  // ── Records token usage when sessionId provided ───────────────────────

  test('records token usage when sessionId is provided', async () => {
    const { recordTokenUsage } = await import('./agent-token.service.js')
    const longContent = 'x'.repeat(600)
    const history = Array.from({ length: 8 }, (_, i) =>
      makeMsg(`msg-${i}`, i % 2 === 0 ? 'user' : 'assistant', longContent),
    )

    await compressContext(history, null, null, null, 'session-123')
    expect(recordTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 50 }),
      'session-123',
      'mock-provider',
      'mock-model',
      { updateSessionContext: false },
    )
  })

  // ── Extends existing summary with new messages ────────────────────────

  test('extends existing summary when new messages are added after cursor', async () => {
    const longContent = 'x'.repeat(600)
    const history = Array.from({ length: 10 }, (_, i) =>
      makeMsg(`msg-${i}`, i % 2 === 0 ? 'user' : 'assistant', longContent),
    )

    // Pretend we already summarized up to msg-2, but now there are more older messages
    const result = await compressContext(history, 'Previous summary', 'msg-2', null)
    expect(result.compressed).toBe(true)
    // The LLM should have been called to extend the summary
    expect(mockLLM.chatWithTools).toHaveBeenCalledOnce()
    const systemMsg = mockLLM.chatWithTools.mock.calls[0][0][1].content as string
    expect(systemMsg).toContain('Previous summary')
  })
})
