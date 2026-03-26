import { describe, expect, test, vi, beforeEach } from 'vitest'

const mockCompletionsCreate = vi.fn()

vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: mockCompletionsCreate,
        },
      },
    })),
  }
})

import { OpenAILLMProvider } from './openai-llm.js'
import type { ChatMessage, LLMToolDefinition } from './llm.interface.js'

let provider: OpenAILLMProvider

beforeEach(() => {
  vi.clearAllMocks()
  provider = new OpenAILLMProvider('gpt-5.4', 'sk-test')
})

describe('OpenAILLMProvider constructor', () => {
  test('sets modelId and providerId', () => {
    expect(provider.modelId).toBe('gpt-5.4')
    expect(provider.providerId).toBe('openai')
  })
})

describe('chatWithTools', () => {
  test('returns text content from response', async () => {
    mockCompletionsCreate.mockResolvedValue({
      choices: [
        {
          message: { content: 'Hello!', tool_calls: undefined },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })

    const result = await provider.chatWithTools([{ role: 'user', content: 'Hi' }])

    expect(result.content).toBe('Hello!')
    expect(result.finishReason).toBe('stop')
  })

  test('extracts tool calls from response', async () => {
    mockCompletionsCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_abc',
                type: 'function',
                function: {
                  name: 'run_bash',
                  arguments: '{"command":"ls"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    })

    const result = await provider.chatWithTools([{ role: 'user', content: 'list files' }])

    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls![0]).toEqual({
      id: 'call_abc',
      name: 'run_bash',
      arguments: { command: 'ls' },
    })
    expect(result.finishReason).toBe('tool_calls')
  })

  test('extracts token usage', async () => {
    mockCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    })

    const result = await provider.chatWithTools([{ role: 'user', content: 'test' }])

    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    })
  })

  test('maps length finish reason', async () => {
    mockCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: 'truncated...' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 4096, total_tokens: 4106 },
    })

    const result = await provider.chatWithTools([{ role: 'user', content: 'long text' }])

    expect(result.finishReason).toBe('length')
  })

  test('handles null content in response', async () => {
    mockCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: null }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
    })

    const result = await provider.chatWithTools([{ role: 'user', content: 'hi' }])

    expect(result.content).toBe('')
  })

  test('passes system message in messages array', async () => {
    mockCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    })

    const messages: ChatMessage[] = [
      { role: 'system', content: 'Be helpful.' },
      { role: 'user', content: 'Hi' },
    ]
    await provider.chatWithTools(messages)

    const callArgs = mockCompletionsCreate.mock.calls[0][0]
    expect(callArgs.messages[0]).toEqual({ role: 'system', content: 'Be helpful.' })
    expect(callArgs.messages[1]).toEqual({ role: 'user', content: 'Hi' })
  })

  test('converts tool definitions to OpenAI format', async () => {
    mockCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    })

    const tools: LLMToolDefinition[] = [
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]

    await provider.chatWithTools([{ role: 'user', content: 'read' }], { tools })

    const callArgs = mockCompletionsCreate.mock.calls[0][0]
    expect(callArgs.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ])
  })

  test('converts tool messages with tool_call_id', async () => {
    mockCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: 'got it' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    })

    const messages: ChatMessage[] = [
      { role: 'user', content: 'run ls' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'run_bash', arguments: { command: 'ls' } }],
      },
      { role: 'tool', content: 'file1.txt', toolCallId: 'call_1' },
    ]
    await provider.chatWithTools(messages)

    const callArgs = mockCompletionsCreate.mock.calls[0][0]
    const toolMsg = callArgs.messages.find((m: { role: string }) => m.role === 'tool')
    expect(toolMsg).toEqual({
      role: 'tool',
      content: 'file1.txt',
      tool_call_id: 'call_1',
    })
  })

  test('converts assistant messages with tool_calls', async () => {
    mockCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    })

    const messages: ChatMessage[] = [
      { role: 'user', content: 'do' },
      {
        role: 'assistant',
        content: 'Running',
        toolCalls: [{ id: 'call_1', name: 'run_bash', arguments: { command: 'ls' } }],
      },
      { role: 'tool', content: 'output', toolCallId: 'call_1' },
    ]
    await provider.chatWithTools(messages)

    const callArgs = mockCompletionsCreate.mock.calls[0][0]
    const assistantMsg = callArgs.messages.find(
      (m: { role: string; tool_calls?: unknown }) => m.role === 'assistant' && m.tool_calls,
    )
    expect(assistantMsg.content).toBe('Running')
    expect(assistantMsg.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'run_bash', arguments: '{"command":"ls"}' },
      },
    ])
  })

  test('handles multimodal user messages with images', async () => {
    mockCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: 'I see it' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
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

    const callArgs = mockCompletionsCreate.mock.calls[0][0]
    expect(callArgs.messages[0].content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
    ])
  })

  test('uses max_completion_tokens for modern models', async () => {
    mockCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    })

    // gpt-5.4 matches the pattern
    await provider.chatWithTools([{ role: 'user', content: 'hi' }], { maxTokens: 2000 })

    const callArgs = mockCompletionsCreate.mock.calls[0][0]
    expect(callArgs.max_completion_tokens).toBe(2000)
    expect(callArgs.max_tokens).toBeUndefined()
  })

  test('uses max_tokens for older models', async () => {
    const legacyProvider = new OpenAILLMProvider('gpt-3.5-turbo', 'sk-test')

    mockCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    })

    await legacyProvider.chatWithTools([{ role: 'user', content: 'hi' }], { maxTokens: 2000 })

    const callArgs = mockCompletionsCreate.mock.calls[0][0]
    expect(callArgs.max_tokens).toBe(2000)
    expect(callArgs.max_completion_tokens).toBeUndefined()
  })

  test('propagates API errors', async () => {
    mockCompletionsCreate.mockRejectedValue(new Error('Rate limit exceeded'))

    await expect(provider.chatWithTools([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      'Rate limit exceeded',
    )
  })

  test('returns undefined usage when not provided', async () => {
    mockCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: undefined,
    })

    const result = await provider.chatWithTools([{ role: 'user', content: 'hi' }])
    expect(result.usage).toBeUndefined()
  })
})

describe('chat', () => {
  test('returns content string from chatWithTools', async () => {
    mockCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    })

    const result = await provider.chat([{ role: 'user', content: 'Hi' }])
    expect(result).toBe('Hello!')
  })
})

describe('stream', () => {
  test('yields content deltas', async () => {
    const chunks = [
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' world' } }] },
      { choices: [{ delta: { content: null } }] },
    ]

    mockCompletionsCreate.mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) {
          yield chunk
        }
      },
    })

    const collected: string[] = []
    for await (const chunk of provider.stream([{ role: 'user', content: 'Hi' }])) {
      collected.push(chunk)
    }

    expect(collected).toEqual(['Hello', ' world'])
  })

  test('passes stream: true in request', async () => {
    mockCompletionsCreate.mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        // empty stream
      },
    })

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of provider.stream([{ role: 'user', content: 'Hi' }])) {
      // consume
    }

    const callArgs = mockCompletionsCreate.mock.calls[0][0]
    expect(callArgs.stream).toBe(true)
  })

  test('filters out tool messages from stream', async () => {
    mockCompletionsCreate.mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'ok' } }] }
      },
    })

    const messages: ChatMessage[] = [
      { role: 'system', content: 'Be helpful' },
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'result', toolCallId: 'tc1' },
      { role: 'user', content: 'thanks' },
    ]

    const collected: string[] = []
    for await (const chunk of provider.stream(messages)) {
      collected.push(chunk)
    }

    const callArgs = mockCompletionsCreate.mock.calls[0][0]
    const roles = callArgs.messages.map((m: { role: string }) => m.role)
    expect(roles).not.toContain('tool')
  })
})
