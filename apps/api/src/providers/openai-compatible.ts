import OpenAI from 'openai'
import type {
  ChatMessage,
  ContentBlock,
  LLMOptions,
  LLMProvider,
  LLMResponse,
  LLMToolDefinition,
  ToolCall,
} from './llm.interface.js'
import { getTextContent } from './llm.interface.js'
import type { EmbeddingProvider } from './embeddings.interface.js'

interface OpenAICompatibleClientOptions {
  apiKey?: string
  baseURL?: string
}

interface OpenAICompatibleLLMOptions extends OpenAICompatibleClientOptions {
  providerId: string
  model: string
  useMaxCompletionTokens?: (model: string) => boolean
}

interface OpenAICompatibleEmbeddingOptions extends OpenAICompatibleClientOptions {
  model: string
}

export function normalizeOpenAICompatibleBaseURL(baseURL: string): string {
  const url = new URL(baseURL)
  const path = url.pathname.replace(/\/+$/, '')

  if (!path || path === '') {
    url.pathname = '/v1'
    return url.toString().replace(/\/$/, '')
  }

  if (path === '/v1') {
    return url.toString().replace(/\/$/, '')
  }

  return url.toString().replace(/\/$/, '')
}

export function createOpenAICompatibleClient(options: OpenAICompatibleClientOptions): OpenAI {
  return new OpenAI({
    apiKey: options.apiKey || 'local',
    ...(options.baseURL ? { baseURL: normalizeOpenAICompatibleBaseURL(options.baseURL) } : {}),
  })
}

export async function listOpenAICompatibleModels(
  options: OpenAICompatibleClientOptions,
): Promise<string[]> {
  const client = createOpenAICompatibleClient(options)
  const list = await client.models.list()
  const models: string[] = []

  for await (const model of list) {
    models.push(model.id)
  }

  return models.sort()
}

export class OpenAICompatibleLLMProvider implements LLMProvider {
  private client: OpenAI
  private model: string
  private useMaxCompletionTokens?: (model: string) => boolean
  readonly modelId: string
  readonly providerId: string

  constructor(options: OpenAICompatibleLLMOptions) {
    this.client = createOpenAICompatibleClient(options)
    this.model = options.model
    this.modelId = options.model
    this.providerId = options.providerId
    this.useMaxCompletionTokens = options.useMaxCompletionTokens
  }

  private tokenLimit(maxTokens: number | undefined): Record<string, number | undefined> {
    if (maxTokens == null) return {}
    return this.useMaxCompletionTokens?.(this.model)
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens }
  }

  async chat(messages: ChatMessage[], options?: LLMOptions): Promise<string> {
    const response = await this.chatWithTools(messages, options)
    return response.content
  }

  async chatWithTools(
    messages: ChatMessage[],
    options?: LLMOptions & { tools?: LLMToolDefinition[] },
  ): Promise<LLMResponse> {
    const openaiMessages = messages.map((m) => {
      if (m.role === 'tool') {
        if (typeof m.content !== 'string' && Array.isArray(m.content)) {
          return {
            role: 'tool' as const,
            content: (m.content as ContentBlock[]).map((b) => {
              if (b.type === 'image') {
                return {
                  type: 'image_url' as const,
                  image_url: { url: `data:${b.source.mediaType};base64,${b.source.data}` },
                }
              }
              return { type: 'text' as const, text: b.text }
            }),
            tool_call_id: m.toolCallId ?? '',
          }
        }

        return {
          role: 'tool' as const,
          content: m.content as string,
          tool_call_id: m.toolCallId ?? '',
        }
      }

      if (m.role === 'assistant' && m.toolCalls?.length) {
        return {
          role: 'assistant' as const,
          content: getTextContent(m.content) || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        }
      }

      if (typeof m.content !== 'string' && Array.isArray(m.content)) {
        return {
          role: m.role as 'system' | 'user' | 'assistant',
          content: (m.content as ContentBlock[]).map((b) => {
            if (b.type === 'image') {
              return {
                type: 'image_url' as const,
                image_url: { url: `data:${b.source.mediaType};base64,${b.source.data}` },
              }
            }
            return { type: 'text' as const, text: b.text }
          }),
        }
      }

      return {
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content as string,
      }
    })

    const tools = options?.tools?.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }))

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: openaiMessages as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      temperature: options?.temperature ?? 0.7,
      ...this.tokenLimit(options?.maxTokens),
      ...(tools?.length ? { tools } : {}),
    })

    const choice = response.choices[0]
    const toolCalls: ToolCall[] | undefined = choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments),
    }))

    let finishReason: LLMResponse['finishReason'] = 'stop'
    if (choice.finish_reason === 'tool_calls') finishReason = 'tool_calls'
    else if (choice.finish_reason === 'length') finishReason = 'length'

    return {
      content: choice.message.content ?? '',
      toolCalls,
      finishReason,
      usage: response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
    }
  }

  async *stream(messages: ChatMessage[], options?: LLMOptions): AsyncIterable<string> {
    const openaiMessages = messages
      .filter((m) => m.role !== 'tool')
      .map((m) => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: getTextContent(m.content),
      }))

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: openaiMessages,
      temperature: options?.temperature ?? 0.7,
      ...this.tokenLimit(options?.maxTokens),
      stream: true,
    })

    for await (const chunk of response) {
      const content = chunk.choices[0]?.delta?.content
      if (content) yield content
    }
  }
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI
  private model: string

  constructor(options: OpenAICompatibleEmbeddingOptions) {
    this.client = createOpenAICompatibleClient(options)
    this.model = options.model
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
    })
    return response.data[0].embedding
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    })
    return response.data.map((d) => d.embedding)
  }
}
