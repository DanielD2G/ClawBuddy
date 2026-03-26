import { describe, expect, test, vi, beforeEach } from 'vitest'

const mockCreate = vi.fn()
const mockStream = vi.fn()

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: mockCreate,
        stream: mockStream,
      },
    })),
  }
})

vi.mock('../constants.js', () => ({
  CLAUDE_DEFAULT_MAX_TOKENS: 4096,
  CLAUDE_DEFAULT_TEMPERATURE: 0.7,
}))

import { ClaudeLLMProvider } from './claude-llm.js'
import type { ChatMessage, LLMToolDefinition } from './llm.interface.js'

let provider: ClaudeLLMProvider

beforeEach(() => {
  vi.clearAllMocks()
  provider = new ClaudeLLMProvider('claude-sonnet-4-6', 'test-api-key')
})

describe('ClaudeLLMProvider constructor', () => {
  test('sets modelId and providerId', () => {
    expect(provider.modelId).toBe('claude-sonnet-4-6')
    expect(provider.providerId).toBe('claude')
  })
})

describe('chatWithTools', () => {
  test('returns text content from response', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Hello world' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }]
    const result = await provider.chatWithTools(messages)

    expect(result.content).toBe('Hello world')
    expect(result.finishReason).toBe('stop')
  })

  test('extracts tool calls from response', async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: 'text', text: 'I will run that command.' },
        {
          type: 'tool_use',
          id: 'toolu_123',
          name: 'run_bash',
          input: { command: 'ls -la' },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 20, output_tokens: 15 },
    })

    const messages: ChatMessage[] = [{ role: 'user', content: 'List files' }]
    const result = await provider.chatWithTools(messages)

    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls![0]).toEqual({
      id: 'toolu_123',
      name: 'run_bash',
      arguments: { command: 'ls -la' },
    })
    expect(result.finishReason).toBe('tool_calls')
  })

  test('extracts token usage', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    })

    const messages: ChatMessage[] = [{ role: 'user', content: 'test' }]
    const result = await provider.chatWithTools(messages)

    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    })
  })

  test('maps max_tokens finish reason to length', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'truncated' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 10, output_tokens: 4096 },
    })

    const messages: ChatMessage[] = [{ role: 'user', content: 'write a long essay' }]
    const result = await provider.chatWithTools(messages)

    expect(result.finishReason).toBe('length')
  })

  test('returns undefined toolCalls when none present', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'No tools needed' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    })

    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }]
    const result = await provider.chatWithTools(messages)

    expect(result.toolCalls).toBeUndefined()
  })

  test('passes system message separately', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'response' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ]
    await provider.chatWithTools(messages)

    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.system).toBe('You are helpful.')
    // System message should NOT appear in messages array
    expect(callArgs.messages).toEqual([{ role: 'user', content: 'Hi' }])
  })

  test('converts tool definitions to Anthropic format', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    const tools: LLMToolDefinition[] = [
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]

    await provider.chatWithTools([{ role: 'user', content: 'read it' }], { tools })

    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.tools).toEqual([
      {
        name: 'read_file',
        description: 'Read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ])
  })

  test('converts tool result messages to user role with tool_result', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'got it' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    const messages: ChatMessage[] = [
      { role: 'user', content: 'run ls' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'run_bash', arguments: { command: 'ls' } }],
      },
      { role: 'tool', content: 'file1.txt\nfile2.txt', toolCallId: 'tc1' },
    ]
    await provider.chatWithTools(messages)

    const callArgs = mockCreate.mock.calls[0][0]
    // Tool messages become user messages with tool_result blocks
    const toolMsg = callArgs.messages.find(
      (m: { role: string; content: unknown }) =>
        m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result',
    )
    expect(toolMsg).toBeDefined()
    expect(toolMsg.content[0].tool_use_id).toBe('tc1')
    expect(toolMsg.content[0].content).toBe('file1.txt\nfile2.txt')
  })

  test('converts assistant messages with tool calls to tool_use blocks', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    const messages: ChatMessage[] = [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: 'Running command',
        toolCalls: [{ id: 'tc1', name: 'run_bash', arguments: { command: 'ls' } }],
      },
      { role: 'tool', content: 'output', toolCallId: 'tc1' },
      { role: 'user', content: 'thanks' },
    ]
    await provider.chatWithTools(messages)

    const callArgs = mockCreate.mock.calls[0][0]
    const assistantMsg = callArgs.messages.find(
      (m: { role: string; content: unknown }) => m.role === 'assistant' && Array.isArray(m.content),
    )
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg.content).toEqual([
      { type: 'text', text: 'Running command' },
      { type: 'tool_use', id: 'tc1', name: 'run_bash', input: { command: 'ls' } },
    ])
  })

  test('handles multimodal user messages with images', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'I see an image' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 10 },
    })

    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          {
            type: 'image',
            source: { type: 'base64', mediaType: 'image/png', data: 'abc123' },
          },
        ],
      },
    ]
    await provider.chatWithTools(messages)

    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.messages[0].content).toEqual([
      { type: 'text', text: 'What is this?' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
      },
    ])
  })

  test('handles tool result with image content', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'screenshot received' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 10 },
    })

    const messages: ChatMessage[] = [
      { role: 'user', content: 'take screenshot' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'screenshot', arguments: {} }],
      },
      {
        role: 'tool',
        toolCallId: 'tc1',
        content: [
          { type: 'text', text: 'Screenshot taken' },
          {
            type: 'image',
            source: { type: 'base64', mediaType: 'image/jpeg', data: 'imgdata' },
          },
        ],
      },
    ]
    await provider.chatWithTools(messages)

    const callArgs = mockCreate.mock.calls[0][0]
    const toolMsg = callArgs.messages.find(
      (m: { role: string; content: unknown }) =>
        m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result',
    )
    expect(toolMsg.content[0].content).toEqual([
      { type: 'text', text: 'Screenshot taken' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'imgdata' },
      },
    ])
  })

  test('uses default temperature and max_tokens', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 },
    })

    await provider.chatWithTools([{ role: 'user', content: 'hi' }])

    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.temperature).toBe(0.7)
    expect(callArgs.max_tokens).toBe(4096)
  })

  test('respects custom temperature and maxTokens', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 },
    })

    await provider.chatWithTools([{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      maxTokens: 1000,
    })

    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.temperature).toBe(0.2)
    expect(callArgs.max_tokens).toBe(1000)
  })

  test('propagates API errors', async () => {
    mockCreate.mockRejectedValue(new Error('Authentication error'))

    await expect(provider.chatWithTools([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      'Authentication error',
    )
  })
})

describe('chat', () => {
  test('returns content string from chatWithTools', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Hello!' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    })

    const result = await provider.chat([{ role: 'user', content: 'Hi' }])
    expect(result).toBe('Hello!')
  })
})

describe('stream', () => {
  test('yields text deltas', async () => {
    const events = [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
      { type: 'message_stop' },
    ]

    mockStream.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        for (const event of events) {
          yield event
        }
      },
    })

    const chunks: string[] = []
    for await (const chunk of provider.stream([{ role: 'user', content: 'Hi' }])) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual(['Hello', ' world'])
  })

  test('skips non-text-delta events', async () => {
    const events = [
      { type: 'message_start', message: {} },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'text' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' } },
    ]

    mockStream.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        for (const event of events) {
          yield event
        }
      },
    })

    const chunks: string[] = []
    for await (const chunk of provider.stream([{ role: 'user', content: 'Hi' }])) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual(['text'])
  })

  test('filters out system and tool messages from stream call', async () => {
    mockStream.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }
      },
    })

    const messages: ChatMessage[] = [
      { role: 'system', content: 'Be helpful' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'tool', content: 'result', toolCallId: 'tc1' },
      { role: 'user', content: 'thanks' },
    ]

    const chunks: string[] = []
    for await (const chunk of provider.stream(messages)) {
      chunks.push(chunk)
    }

    const callArgs = mockStream.mock.calls[0][0]
    // System message passed separately
    expect(callArgs.system).toBe('Be helpful')
    // Tool messages filtered out
    const roles = callArgs.messages.map((m: { role: string }) => m.role)
    expect(roles).not.toContain('system')
    expect(roles).not.toContain('tool')
  })
})
