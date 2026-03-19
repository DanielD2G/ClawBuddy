import OpenAI from 'openai'
import type {
  LLMProvider,
  ChatMessage,
  LLMOptions,
  LLMToolDefinition,
  LLMResponse,
  ToolCall,
  ContentBlock,
} from './llm.interface.js'
import { getTextContent } from './llm.interface.js'

/** Models that only accept max_completion_tokens (not max_tokens). */
function usesMaxCompletionTokens(model: string): boolean {
  return /^(o[134]|gpt-4\.1|gpt-4o|gpt-5)/.test(model)
}

export class OpenAILLMProvider implements LLMProvider {
  private client: OpenAI
  private model: string
  readonly modelId: string
  readonly providerId = 'openai'

  constructor(model = 'gpt-5.4', apiKey?: string) {
    this.client = new OpenAI({ apiKey })
    this.model = model
    this.modelId = model
  }

  private tokenLimit(maxTokens: number | undefined): Record<string, number | undefined> {
    if (maxTokens == null) return {}
    return usesMaxCompletionTokens(this.model)
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
        // OpenAI tool results: if multimodal, map to content parts
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
      // Handle multimodal user messages
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
