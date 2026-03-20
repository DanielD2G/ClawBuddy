import {
  GoogleGenerativeAI,
  type Content,
  type FunctionDeclaration,
  type Part,
  SchemaType,
} from '@google/generative-ai'
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

export class GeminiLLMProvider implements LLMProvider {
  private client: GoogleGenerativeAI
  private model: string
  readonly modelId: string
  readonly providerId = 'gemini'

  constructor(model = 'gemini-2.5-flash', apiKey?: string) {
    this.client = new GoogleGenerativeAI(apiKey ?? '')
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

    const functionDeclarations: FunctionDeclaration[] | undefined = options?.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: {
        type: SchemaType.OBJECT,
        properties: (t.parameters as Record<string, unknown>).properties,
        required: (t.parameters as Record<string, unknown>).required,
      } as FunctionDeclaration['parameters'],
    }))

    const model = this.client.getGenerativeModel({
      model: this.model,
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxTokens,
      },
      ...(functionDeclarations?.length ? { tools: [{ functionDeclarations }] } : {}),
    })

    // Build history (all messages except system and last user message)
    const nonSystemMessages = messages.filter((m) => m.role !== 'system')
    const history = nonSystemMessages.slice(0, -1).flatMap<Content>((m) => {
      if (m.role === 'tool') {
        // Gemini's function role can ONLY contain functionResponse parts — no inlineData.
        // When tool results include screenshots, split into function + user messages.
        if (typeof m.content !== 'string' && Array.isArray(m.content)) {
          const textParts = (m.content as ContentBlock[]).filter((b) => b.type === 'text')
          const textResult = textParts.map((b) => (b as { text: string }).text).join('')
          const imageParts = (m.content as ContentBlock[]).filter((b) => b.type === 'image')

          const msgs: Content[] = [
            {
              role: 'function',
              parts: [
                {
                  functionResponse: {
                    name: m.toolCallId ?? 'unknown',
                    response: { result: textResult },
                  },
                },
              ],
            },
          ]
          if (imageParts.length > 0) {
            msgs.push({
              role: 'user',
              parts: imageParts.map((b) => ({
                inlineData: {
                  mimeType: (b as { source: { mediaType: string; data: string } }).source.mediaType,
                  data: (b as { source: { mediaType: string; data: string } }).source.data,
                },
              })),
            })
          }
          return msgs
        }
        return [
          {
            role: 'function' as const,
            parts: [
              {
                functionResponse: {
                  name: m.toolCallId ?? 'unknown',
                  response: { result: m.content as string },
                },
              },
            ],
          },
        ]
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        // Use raw parts if available (preserves thought_signature for Gemini)
        const hasRawParts = m.toolCalls.some((tc) => tc._rawParts)
        const textContent = getTextContent(m.content)
        if (hasRawParts) {
          const parts: Array<
            { text: string } | { functionCall: { name: string; args: Record<string, unknown> } }
          > = []
          if (textContent) parts.push({ text: textContent })
          for (const tc of m.toolCalls) {
            parts.push(
              (tc._rawParts ?? { functionCall: { name: tc.name, args: tc.arguments } }) as {
                functionCall: { name: string; args: Record<string, unknown> }
              },
            )
          }
          return [{ role: 'model' as const, parts }]
        }
        const parts: Array<
          { text: string } | { functionCall: { name: string; args: Record<string, unknown> } }
        > = []
        if (textContent) parts.push({ text: textContent })
        for (const tc of m.toolCalls) {
          parts.push({
            functionCall: { name: tc.name, args: tc.arguments },
          })
        }
        return [{ role: 'model' as const, parts }]
      }
      // Handle multimodal content
      if (typeof m.content !== 'string' && Array.isArray(m.content)) {
        const parts: Part[] = []
        for (const b of m.content as ContentBlock[]) {
          if (b.type === 'image') {
            parts.push({ inlineData: { mimeType: b.source.mediaType, data: b.source.data } })
          } else {
            parts.push({ text: b.text })
          }
        }
        return [
          {
            role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
            parts,
          },
        ]
      }
      return [
        {
          role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
          parts: [{ text: m.content as string }],
        },
      ]
    })

    const lastMessage = nonSystemMessages[nonSystemMessages.length - 1]
    const chat = model.startChat({
      history,
      ...(systemMessage && {
        systemInstruction: {
          role: 'user',
          parts: [{ text: getTextContent(systemMessage.content) }],
        },
      }),
    })

    const lastContent =
      lastMessage.role === 'tool'
        ? [
            {
              functionResponse: {
                name: lastMessage.toolCallId ?? 'unknown',
                response: { result: getTextContent(lastMessage.content) },
              },
            },
          ]
        : getTextContent(lastMessage.content)

    const result = await chat.sendMessage(lastContent)
    const response = result.response

    // Extract function calls, preserving raw parts (including thought_signature)
    const toolCalls: ToolCall[] = []
    for (const candidate of response.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        if ('functionCall' in part && part.functionCall) {
          toolCalls.push({
            id: `gemini_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: part.functionCall.name,
            arguments: (part.functionCall.args as Record<string, unknown>) ?? {},
            _rawParts: part,
          })
        }
      }
    }

    const finishReason: LLMResponse['finishReason'] = toolCalls.length ? 'tool_calls' : 'stop'

    const usageMeta = response.usageMetadata
    return {
      content: response.text() ?? '',
      toolCalls: toolCalls.length ? toolCalls : undefined,
      finishReason,
      usage: usageMeta
        ? {
            inputTokens: usageMeta.promptTokenCount ?? 0,
            outputTokens: usageMeta.candidatesTokenCount ?? 0,
            totalTokens: usageMeta.totalTokenCount ?? 0,
          }
        : undefined,
    }
  }

  async *stream(messages: ChatMessage[], options?: LLMOptions): AsyncIterable<string> {
    const model = this.client.getGenerativeModel({
      model: this.model,
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxTokens,
      },
    })

    const systemMessage = messages.find((m) => m.role === 'system')
    const history: Content[] = messages
      .filter((m) => m.role !== 'system' && m.role !== 'tool')
      .slice(0, -1)
      .map((m) => ({
        role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
        parts: [{ text: getTextContent(m.content) }],
      }))

    const lastMessage = messages[messages.length - 1]
    const chat = model.startChat({
      history,
      ...(systemMessage && {
        systemInstruction: {
          role: 'user',
          parts: [{ text: getTextContent(systemMessage.content) }],
        },
      }),
    })

    const result = await chat.sendMessageStream(getTextContent(lastMessage.content))
    for await (const chunk of result.stream) {
      const text = chunk.text()
      if (text) yield text
    }
  }
}
