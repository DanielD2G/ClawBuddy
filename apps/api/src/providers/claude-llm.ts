import Anthropic from '@anthropic-ai/sdk'
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
import { CLAUDE_DEFAULT_MAX_TOKENS, CLAUDE_DEFAULT_TEMPERATURE } from '../constants.js'

export class ClaudeLLMProvider implements LLMProvider {
  private client: Anthropic
  private model: string
  readonly modelId: string
  readonly providerId = 'claude'

  constructor(model = 'claude-sonnet-4-6', apiKey?: string) {
    this.client = new Anthropic({ apiKey })
    this.model = model
    this.modelId = model
  }

  async chat(messages: ChatMessage[], options?: LLMOptions): Promise<string> {
    const response = await this.chatWithTools(messages, options)
    return response.content
  }

  async chatWithTools(
    messages: ChatMessage[],
    options?: LLMOptions & { tools?: LLMToolDefinition[] },
  ): Promise<LLMResponse> {
    const systemMessage = messages.find((m) => m.role === 'system')

    const anthropicMessages: Anthropic.Messages.MessageParam[] = []
    for (const m of messages) {
      if (m.role === 'system') continue

      if (m.role === 'tool') {
        const toolResultContent: Anthropic.Messages.ToolResultBlockParam['content'] =
          typeof m.content === 'string'
            ? m.content
            : (m.content as ContentBlock[]).map((b) => {
                if (b.type === 'image') {
                  return {
                    type: 'image' as const,
                    source: {
                      type: 'base64' as const,
                      media_type: b.source.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                      data: b.source.data,
                    },
                  }
                }
                return { type: 'text' as const, text: b.text }
              })
        anthropicMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: m.toolCallId ?? '',
              content: toolResultContent,
            },
          ],
        })
        continue
      }

      if (m.role === 'assistant' && m.toolCalls?.length) {
        const content: Anthropic.Messages.ContentBlockParam[] = []
        const textContent = getTextContent(m.content)
        if (textContent) {
          content.push({ type: 'text', text: textContent })
        }
        for (const tc of m.toolCalls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          })
        }
        anthropicMessages.push({ role: 'assistant', content })
        continue
      }

      // Handle multimodal content for user messages
      if (typeof m.content !== 'string' && Array.isArray(m.content)) {
        anthropicMessages.push({
          role: m.role as 'user' | 'assistant',
          content: (m.content as ContentBlock[]).map((b) => {
            if (b.type === 'image') {
              return {
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: b.source.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                  data: b.source.data,
                },
              }
            }
            return { type: 'text' as const, text: b.text }
          }),
        })
      } else {
        anthropicMessages.push({
          role: m.role as 'user' | 'assistant',
          content: m.content as string,
        })
      }
    }

    const tools: Anthropic.Messages.Tool[] | undefined = options?.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Messages.Tool['input_schema'],
    }))

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: options?.maxTokens ?? CLAUDE_DEFAULT_MAX_TOKENS,
      temperature: options?.temperature ?? CLAUDE_DEFAULT_TEMPERATURE,
      ...(systemMessage && { system: getTextContent(systemMessage.content) }),
      messages: anthropicMessages,
      ...(tools?.length ? { tools } : {}),
    })

    let textContent = ''
    const toolCalls: ToolCall[] = []

    for (const block of response.content) {
      if (block.type === 'text') {
        textContent += block.text
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        })
      }
    }

    let finishReason: LLMResponse['finishReason'] = 'stop'
    if (response.stop_reason === 'tool_use') finishReason = 'tool_calls'
    else if (response.stop_reason === 'max_tokens') finishReason = 'length'

    return {
      content: textContent,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      finishReason,
      usage: response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            totalTokens: response.usage.input_tokens + response.usage.output_tokens,
          }
        : undefined,
    }
  }

  async *stream(messages: ChatMessage[], options?: LLMOptions): AsyncIterable<string> {
    const systemMessage = messages.find((m) => m.role === 'system')
    const chatMessages = messages
      .filter((m) => m.role !== 'system' && m.role !== 'tool')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: getTextContent(m.content) }))

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: options?.maxTokens ?? CLAUDE_DEFAULT_MAX_TOKENS,
      temperature: options?.temperature ?? CLAUDE_DEFAULT_TEMPERATURE,
      ...(systemMessage && { system: getTextContent(systemMessage.content) }),
      messages: chatMessages,
    })

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text
      }
    }
  }
}
