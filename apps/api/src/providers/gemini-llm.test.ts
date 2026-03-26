import { describe, expect, test, vi, beforeEach } from 'vitest'

const mockSendMessage = vi.fn()
const mockStartChat = vi.fn().mockReturnValue({ sendMessage: mockSendMessage })
const mockGetGenerativeModel = vi.fn().mockReturnValue({ startChat: mockStartChat })

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: mockGetGenerativeModel,
  })),
  SchemaType: { OBJECT: 'OBJECT' },
}))

import { GeminiLLMProvider } from './gemini-llm.js'
import type { ChatMessage, LLMToolDefinition } from './llm.interface.js'

let provider: GeminiLLMProvider

beforeEach(() => {
  vi.clearAllMocks()
  mockGetGenerativeModel.mockReturnValue({ startChat: mockStartChat })
  mockStartChat.mockReturnValue({ sendMessage: mockSendMessage })
  provider = new GeminiLLMProvider('gemini-2.5-flash', 'test-api-key')
})

describe('GeminiLLMProvider constructor', () => {
  test('sets modelId and providerId', () => {
    expect(provider.modelId).toBe('gemini-2.5-flash')
    expect(provider.providerId).toBe('gemini')
  })
})

describe('chatWithTools', () => {
  test('returns text content from response', async () => {
    mockSendMessage.mockResolvedValue({
      response: {
        text: () => 'Hello world',
        candidates: [{ content: { parts: [{ text: 'Hello world' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      },
    })

    const result = await provider.chatWithTools([{ role: 'user', content: 'Hi' }])

    expect(result.content).toBe('Hello world')
    expect(result.finishReason).toBe('stop')
  })

  test('extracts function calls from response', async () => {
    mockSendMessage.mockResolvedValue({
      response: {
        text: () => '',
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'run_bash',
                    args: { command: 'ls' },
                  },
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8, totalTokenCount: 18 },
      },
    })

    const result = await provider.chatWithTools([{ role: 'user', content: 'list files' }])

    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls![0].name).toBe('run_bash')
    expect(result.toolCalls![0].arguments).toEqual({ command: 'ls' })
    expect(result.toolCalls![0].id).toMatch(/^gemini_/)
    expect(result.toolCalls![0]._rawParts).toBeDefined()
    expect(result.finishReason).toBe('tool_calls')
  })

  test('extracts token usage', async () => {
    mockSendMessage.mockResolvedValue({
      response: {
        text: () => 'ok',
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
      },
    })

    const result = await provider.chatWithTools([{ role: 'user', content: 'test' }])

    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    })
  })

  test('returns undefined usage when metadata missing', async () => {
    mockSendMessage.mockResolvedValue({
      response: {
        text: () => 'ok',
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: undefined,
      },
    })

    const result = await provider.chatWithTools([{ role: 'user', content: 'test' }])
    expect(result.usage).toBeUndefined()
  })

  test('returns undefined toolCalls when none present', async () => {
    mockSendMessage.mockResolvedValue({
      response: {
        text: () => 'Just text',
        candidates: [{ content: { parts: [{ text: 'Just text' }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
      },
    })

    const result = await provider.chatWithTools([{ role: 'user', content: 'hello' }])
    expect(result.toolCalls).toBeUndefined()
  })

  test('passes system message as systemInstruction', async () => {
    mockSendMessage.mockResolvedValue({
      response: {
        text: () => 'ok',
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
      },
    })

    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ]
    await provider.chatWithTools(messages)

    const chatArgs = mockStartChat.mock.calls[0][0]
    expect(chatArgs.systemInstruction).toEqual({
      role: 'user',
      parts: [{ text: 'You are helpful.' }],
    })
  })

  test('converts tool definitions to Gemini functionDeclarations', async () => {
    mockSendMessage.mockResolvedValue({
      response: {
        text: () => '',
        candidates: [{ content: { parts: [] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
      },
    })

    const tools: LLMToolDefinition[] = [
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ]

    await provider.chatWithTools([{ role: 'user', content: 'read' }], { tools })

    const modelArgs = mockGetGenerativeModel.mock.calls[0][0]
    expect(modelArgs.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'read_file',
            description: 'Read a file',
            parameters: {
              type: 'OBJECT',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        ],
      },
    ])
  })

  test('converts tool result messages to function role', async () => {
    mockSendMessage.mockResolvedValue({
      response: {
        text: () => 'got it',
        candidates: [{ content: { parts: [{ text: 'got it' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
      },
    })

    const messages: ChatMessage[] = [
      { role: 'user', content: 'run ls' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'run_bash', arguments: { command: 'ls' } }],
      },
      { role: 'tool', content: 'file1.txt', toolCallId: 'run_bash' },
      { role: 'user', content: 'thanks' },
    ]
    await provider.chatWithTools(messages)

    const chatArgs = mockStartChat.mock.calls[0][0]
    const functionMsg = chatArgs.history.find((h: { role: string }) => h.role === 'function')
    expect(functionMsg).toBeDefined()
    expect(functionMsg.parts[0].functionResponse.name).toBe('run_bash')
    expect(functionMsg.parts[0].functionResponse.response).toEqual({ result: 'file1.txt' })
  })

  test('converts assistant tool call messages to model with functionCall parts', async () => {
    mockSendMessage.mockResolvedValue({
      response: {
        text: () => 'done',
        candidates: [{ content: { parts: [{ text: 'done' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
      },
    })

    const messages: ChatMessage[] = [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: 'Running',
        toolCalls: [{ id: 'tc1', name: 'run_bash', arguments: { command: 'ls' } }],
      },
      { role: 'tool', content: 'output', toolCallId: 'run_bash' },
      { role: 'user', content: 'ok' },
    ]
    await provider.chatWithTools(messages)

    const chatArgs = mockStartChat.mock.calls[0][0]
    const modelMsg = chatArgs.history.find((h: { role: string }) => h.role === 'model')
    expect(modelMsg).toBeDefined()
    expect(modelMsg.parts).toEqual([
      { text: 'Running' },
      { functionCall: { name: 'run_bash', args: { command: 'ls' } } },
    ])
  })

  test('handles multimodal user messages with images', async () => {
    mockSendMessage.mockResolvedValue({
      response: {
        text: () => 'I see an image',
        candidates: [{ content: { parts: [{ text: 'I see an image' }] } }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, totalTokenCount: 60 },
      },
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
      { role: 'user', content: 'describe it' },
    ]
    await provider.chatWithTools(messages)

    const chatArgs = mockStartChat.mock.calls[0][0]
    // First message (in history) should have image parts
    const imageMsg = chatArgs.history.find((h: { parts: Array<{ inlineData?: unknown }> }) =>
      h.parts.some((p: { inlineData?: unknown }) => p.inlineData),
    )
    expect(imageMsg).toBeDefined()
    expect(imageMsg.parts).toEqual([
      { text: 'What is this?' },
      { inlineData: { mimeType: 'image/png', data: 'abc123' } },
    ])
  })

  test('sends last tool message as functionResponse content', async () => {
    mockSendMessage.mockResolvedValue({
      response: {
        text: () => 'processed',
        candidates: [{ content: { parts: [{ text: 'processed' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      },
    })

    const messages: ChatMessage[] = [
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'run_bash', arguments: { command: 'echo hi' } }],
      },
      { role: 'tool', content: 'hi', toolCallId: 'run_bash' },
    ]
    await provider.chatWithTools(messages)

    // The last message is a tool message, so it should be sent as functionResponse
    const sendArgs = mockSendMessage.mock.calls[0][0]
    expect(sendArgs).toEqual([
      {
        functionResponse: {
          name: 'run_bash',
          response: { result: 'hi' },
        },
      },
    ])
  })

  test('uses default temperature 0.7', async () => {
    mockSendMessage.mockResolvedValue({
      response: {
        text: () => 'ok',
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
      },
    })

    await provider.chatWithTools([{ role: 'user', content: 'hi' }])

    const modelArgs = mockGetGenerativeModel.mock.calls[0][0]
    expect(modelArgs.generationConfig.temperature).toBe(0.7)
  })

  test('respects custom temperature and maxTokens', async () => {
    mockSendMessage.mockResolvedValue({
      response: {
        text: () => 'ok',
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
      },
    })

    await provider.chatWithTools([{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      maxTokens: 1000,
    })

    const modelArgs = mockGetGenerativeModel.mock.calls[0][0]
    expect(modelArgs.generationConfig.temperature).toBe(0.2)
    expect(modelArgs.generationConfig.maxOutputTokens).toBe(1000)
  })

  test('propagates API errors', async () => {
    mockSendMessage.mockRejectedValue(new Error('API quota exceeded'))

    await expect(provider.chatWithTools([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      'API quota exceeded',
    )
  })

  test('handles tool result with image content (split into function + user messages)', async () => {
    mockSendMessage.mockResolvedValue({
      response: {
        text: () => 'screenshot received',
        candidates: [{ content: { parts: [{ text: 'screenshot received' }] } }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, totalTokenCount: 60 },
      },
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
        toolCallId: 'screenshot',
        content: [
          { type: 'text', text: 'Screenshot taken' },
          {
            type: 'image',
            source: { type: 'base64', mediaType: 'image/jpeg', data: 'imgdata' },
          },
        ],
      },
      { role: 'user', content: 'what do you see' },
    ]
    await provider.chatWithTools(messages)

    const chatArgs = mockStartChat.mock.calls[0][0]
    // Should have a function message followed by a user message with image
    const functionMsg = chatArgs.history.find((h: { role: string }) => h.role === 'function')
    expect(functionMsg).toBeDefined()
    expect(functionMsg.parts[0].functionResponse.response).toEqual({ result: 'Screenshot taken' })

    const imageUserMsg = chatArgs.history.find(
      (h: { role: string; parts: Array<{ inlineData?: unknown }> }) =>
        h.role === 'user' && h.parts.some((p: { inlineData?: unknown }) => p.inlineData),
    )
    expect(imageUserMsg).toBeDefined()
    expect(imageUserMsg.parts[0].inlineData).toEqual({
      mimeType: 'image/jpeg',
      data: 'imgdata',
    })
  })

  test('preserves raw parts when _rawParts is set on tool calls', async () => {
    mockSendMessage.mockResolvedValue({
      response: {
        text: () => 'done',
        candidates: [{ content: { parts: [{ text: 'done' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
      },
    })

    const rawPart = {
      functionCall: { name: 'run_bash', args: { command: 'ls' } },
      thought_signature: 'abc',
    }
    const messages: ChatMessage[] = [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tc1', name: 'run_bash', arguments: { command: 'ls' }, _rawParts: rawPart },
        ],
      },
      { role: 'tool', content: 'output', toolCallId: 'run_bash' },
      { role: 'user', content: 'ok' },
    ]
    await provider.chatWithTools(messages)

    const chatArgs = mockStartChat.mock.calls[0][0]
    const modelMsg = chatArgs.history.find((h: { role: string }) => h.role === 'model')
    expect(modelMsg.parts).toEqual([rawPart])
  })
})

describe('chat', () => {
  test('returns content string from chatWithTools', async () => {
    mockSendMessage.mockResolvedValue({
      response: {
        text: () => 'Hello!',
        candidates: [{ content: { parts: [{ text: 'Hello!' }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
      },
    })

    const result = await provider.chat([{ role: 'user', content: 'Hi' }])
    expect(result).toBe('Hello!')
  })
})

describe('stream', () => {
  test('yields text chunks', async () => {
    const mockSendMessageStream = vi.fn().mockResolvedValue({
      stream: (async function* () {
        yield { text: () => 'Hello' }
        yield { text: () => ' world' }
        yield { text: () => '' }
      })(),
    })

    mockStartChat.mockReturnValue({
      sendMessage: mockSendMessage,
      sendMessageStream: mockSendMessageStream,
    })

    const chunks: string[] = []
    for await (const chunk of provider.stream([{ role: 'user', content: 'Hi' }])) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual(['Hello', ' world'])
  })

  test('filters out system and tool messages for stream history', async () => {
    const mockSendMessageStream = vi.fn().mockResolvedValue({
      stream: (async function* () {
        yield { text: () => 'ok' }
      })(),
    })

    mockStartChat.mockReturnValue({
      sendMessage: mockSendMessage,
      sendMessageStream: mockSendMessageStream,
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

    const chatArgs = mockStartChat.mock.calls[0][0]
    // System instruction passed separately
    expect(chatArgs.systemInstruction).toBeDefined()
    // History should not contain system or tool messages
    const roles = chatArgs.history.map((h: { role: string }) => h.role)
    expect(roles).not.toContain('system')
    expect(roles).not.toContain('function')
    expect(roles).not.toContain('tool')
  })
})
