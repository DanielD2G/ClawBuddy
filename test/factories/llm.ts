import { vi } from 'vitest'
import type { LLMProvider, LLMResponse } from '../../apps/api/src/providers/llm.interface.js'

interface MockLLMProviderOptions {
  /** Default response content for chatWithTools / chat */
  response?: Partial<LLMResponse>
  /** If provided, chatWithTools/chat will reject with this error */
  error?: Error
  /** Provider ID to report */
  providerId?: string
  /** Model ID to report */
  modelId?: string
}

/**
 * Create a mock LLM provider that returns predictable responses.
 *
 * Usage:
 *   const llm = createMockLLMProvider({ response: { content: 'Hello' } })
 *   const result = await llm.chatWithTools([...])
 *   // result.content === 'Hello'
 *
 *   // Configure tool calls:
 *   const llm2 = createMockLLMProvider({
 *     response: {
 *       content: '',
 *       toolCalls: [{ id: 'tc1', name: 'run_bash', arguments: { command: 'ls' } }],
 *       finishReason: 'tool_calls',
 *     },
 *   })
 *
 *   // Simulate errors:
 *   const llm3 = createMockLLMProvider({ error: new Error('Rate limited') })
 */
export function createMockLLMProvider(options: MockLLMProviderOptions = {}): LLMProvider & {
  chat: ReturnType<typeof vi.fn>
  chatWithTools: ReturnType<typeof vi.fn>
  stream: ReturnType<typeof vi.fn>
} {
  const defaultResponse: LLMResponse = {
    content: options.response?.content ?? 'Mock LLM response',
    toolCalls: options.response?.toolCalls ?? [],
    finishReason: options.response?.finishReason ?? 'stop',
    usage: options.response?.usage ?? {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    },
  }

  const chatImpl = options.error
    ? vi.fn().mockRejectedValue(options.error)
    : vi.fn().mockResolvedValue(defaultResponse.content)

  const chatWithToolsImpl = options.error
    ? vi.fn().mockRejectedValue(options.error)
    : vi.fn().mockResolvedValue(defaultResponse)

  const streamImpl = options.error
    ? vi.fn().mockImplementation(async function* () {
        throw options.error
      })
    : vi.fn().mockImplementation(async function* () {
        yield defaultResponse.content
      })

  return {
    modelId: options.modelId ?? 'mock-model',
    providerId: options.providerId ?? 'mock-provider',
    chat: chatImpl,
    chatWithTools: chatWithToolsImpl,
    stream: streamImpl,
  }
}
