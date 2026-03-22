import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'
import { tool as defineTool } from '@langchain/core/tools'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai'
import { settingsService } from '../services/settings.service.js'
import { discoverEmbeddingModels, discoverLLMModels } from '../services/model-discovery.service.js'
import type { EmbeddingProvider } from './embeddings.interface.js'
import type {
  ChatMessage,
  ContentBlock,
  LLMOptions,
  LLMProvider,
  LLMResponse,
  LLMToolDefinition,
  TokenUsage,
  ToolCall,
} from './llm.interface.js'
import { z } from 'zod'

type ProviderCredentialResolver = (provider: string) => Promise<string | null>

const IMAGE_BLOCK_TYPES = new Set(['image'])

const embeddingRegistry = new Map<
  string,
  {
    create: (model: string, credential: string | null) => EmbeddingProvider
    resolve: ProviderCredentialResolver
  }
>([
  [
    'openai',
    {
      create: (model, credential) =>
        new LangChainEmbeddingProvider(
          new OpenAIEmbeddings({
            model,
            apiKey: credential ?? undefined,
          }),
        ),
      resolve: (provider) => settingsService.getApiKey(provider),
    },
  ],
  [
    'gemini',
    {
      create: (model, credential) =>
        new LangChainEmbeddingProvider(
          new OpenAIEmbeddings({
            model,
            apiKey: credential ?? undefined,
            configuration: {
              baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
            },
          }),
        ),
      resolve: (provider) => settingsService.getApiKey(provider),
    },
  ],
  [
    'local',
    {
      create: (model, credential) =>
        new LangChainEmbeddingProvider(
          new OpenAIEmbeddings({
            model,
            apiKey: 'local',
            configuration: {
              baseURL: normalizeBaseUrl(credential),
            },
          }),
        ),
      resolve: () => settingsService.getLocalBaseUrl(),
    },
  ],
])

const llmRegistry = new Map<
  string,
  {
    create: (model: string, credential: string | null) => LLMProvider
    resolve: ProviderCredentialResolver
  }
>([
  [
    'openai',
    {
      create: (model, credential) =>
        new LangChainLLMProvider(
          'openai',
          model,
          new ChatOpenAI({
            model,
            apiKey: credential ?? undefined,
          }),
        ),
      resolve: (provider) => settingsService.getApiKey(provider),
    },
  ],
  [
    'gemini',
    {
      create: (model, credential) =>
        new LangChainLLMProvider(
          'gemini',
          model,
          new ChatGoogleGenerativeAI({
            model,
            apiKey: credential ?? undefined,
          }),
        ),
      resolve: (provider) => settingsService.getApiKey(provider),
    },
  ],
  [
    'claude',
    {
      create: (model, credential) =>
        new LangChainLLMProvider(
          'claude',
          model,
          new ChatAnthropic({
            model,
            apiKey: credential ?? undefined,
          }),
        ),
      resolve: (provider) => settingsService.getApiKey(provider),
    },
  ],
  [
    'local',
    {
      create: (model, credential) =>
        new LangChainLLMProvider(
          'local',
          model,
          new ChatOpenAI({
            model,
            apiKey: 'local',
            configuration: {
              baseURL: normalizeBaseUrl(credential),
            },
          }),
        ),
      resolve: () => settingsService.getLocalBaseUrl(),
    },
  ],
])

function normalizeBaseUrl(baseUrl: string | null): string {
  const value = (baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!value) {
    throw new Error('A base URL is required for the local provider')
  }
  return value.endsWith('/v1') ? value : `${value}/v1`
}

function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return z.any()
  }

  const definition = schema as Record<string, unknown>
  const type = definition.type

  if (Array.isArray(definition.enum) && definition.enum.length > 0) {
    const values = definition.enum.filter((value): value is string => typeof value === 'string')
    if (values.length > 0) return z.enum(values as [string, ...string[]])
  }

  switch (type) {
    case 'string':
      return z.string()
    case 'number':
      return z.number()
    case 'integer':
      return z.number().int()
    case 'boolean':
      return z.boolean()
    case 'array':
      return z.array(jsonSchemaToZod(definition.items))
    case 'object': {
      const properties =
        definition.properties && typeof definition.properties === 'object'
          ? (definition.properties as Record<string, unknown>)
          : {}
      const required = new Set(
        Array.isArray(definition.required)
          ? definition.required.filter((value): value is string => typeof value === 'string')
          : [],
      )

      const shape = Object.fromEntries(
        Object.entries(properties).map(([key, value]) => {
          const propertySchema = jsonSchemaToZod(value)
          return [key, required.has(key) ? propertySchema : propertySchema.optional()]
        }),
      )

      return z.object(shape)
    }
    default:
      return z.any()
  }
}

function convertToolDefinitionsToLangChainTools(tools: LLMToolDefinition[]) {
  return tools.map((toolDef) =>
    defineTool(
      async (_input) => {
        throw new Error(`Tool "${toolDef.name}" can only be executed inside LangGraph.`)
      },
      {
        name: toolDef.name,
        description: toolDef.description,
        schema: jsonSchemaToZod(toolDef.parameters),
      },
    ),
  )
}

function convertContentBlock(block: ContentBlock): { type: string; [key: string]: unknown } {
  if (block.type === 'text') {
    return { type: 'text', text: block.text }
  }

  if (IMAGE_BLOCK_TYPES.has(block.type)) {
    return {
      type: 'image_url',
      image_url: {
        url: `data:${block.source.mediaType};base64,${block.source.data}`,
      },
    }
  }

  return { type: 'text', text: '' }
}

function toLangChainMessage(message: ChatMessage) {
  const content =
    typeof message.content === 'string'
      ? message.content
      : message.content.map((block) => convertContentBlock(block))

  switch (message.role) {
    case 'system':
      return new SystemMessage(content)
    case 'user':
      return new HumanMessage(content)
    case 'tool':
      return new ToolMessage({
        content,
        tool_call_id: message.toolCallId ?? 'tool',
      })
    case 'assistant':
    default:
      return new AIMessage({
        content,
        tool_calls: message.toolCalls?.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          args: toolCall.arguments,
          type: 'tool_call' as const,
        })),
      })
  }
}

function normalizeContent(content: AIMessage['content']): string {
  if (typeof content === 'string') return content

  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part.type === 'text' && typeof part.text === 'string') return part.text
      return ''
    })
    .join('')
}

function normalizeUsage(model: string, message: AIMessage): TokenUsage | undefined {
  const usage = message.usage_metadata
  if (!usage) return undefined

  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    totalTokens: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
  }
}

function normalizeToolCalls(message: AIMessage): ToolCall[] | undefined {
  if (!message.tool_calls?.length) return undefined

  return message.tool_calls.map((toolCall) => ({
    id: toolCall.id ?? `${toolCall.name}_${Date.now()}`,
    name: toolCall.name,
    arguments:
      toolCall.args && typeof toolCall.args === 'object' && !Array.isArray(toolCall.args)
        ? (toolCall.args as Record<string, unknown>)
        : {},
  }))
}

class LangChainEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly provider: {
      embedQuery(text: string): Promise<number[]>
      embedDocuments(texts: string[]): Promise<number[][]>
    },
  ) {}

  async embed(text: string) {
    return this.provider.embedQuery(text)
  }

  async embedBatch(texts: string[]) {
    return this.provider.embedDocuments(texts)
  }
}

class LangChainLLMProvider implements LLMProvider {
  constructor(
    readonly providerId: string,
    readonly modelId: string,
    private readonly model: BaseChatModel,
  ) {}

  async chat(messages: ChatMessage[], options?: LLMOptions) {
    const response = await this.invoke(messages, options)
    return response.content
  }

  async chatWithTools(
    messages: ChatMessage[],
    options?: LLMOptions & { tools?: LLMToolDefinition[] },
  ): Promise<LLMResponse> {
    return this.invoke(messages, options)
  }

  async *stream(messages: ChatMessage[], options?: LLMOptions): AsyncIterable<string> {
    const runnable = this.getRunnable(options)
    const stream = await runnable.stream(toLangChainMessages(messages))

    for await (const chunk of stream) {
      const text = normalizeContent((chunk as AIMessage).content)
      if (text) yield text
    }
  }

  private async invoke(
    messages: ChatMessage[],
    options?: LLMOptions & { tools?: LLMToolDefinition[] },
  ): Promise<LLMResponse> {
    const runnable = this.getRunnable(options)
    const response = (await runnable.invoke(toLangChainMessages(messages))) as AIMessage
    const content = normalizeContent(response.content)
    const toolCalls = normalizeToolCalls(response)

    return {
      content,
      toolCalls,
      finishReason: toolCalls?.length ? 'tool_calls' : 'stop',
      usage: normalizeUsage(this.modelId, response),
    }
  }

  private getRunnable(options?: LLMOptions & { tools?: LLMToolDefinition[] }) {
    const base =
      (
        this.model as BaseChatModel & {
          bind?: (fields: Record<string, unknown>) => BaseChatModel
          bindTools?: (tools: unknown[]) => BaseChatModel
        }
      ).bind?.({
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      }) ?? this.model

    if (!options?.tools?.length) return base

    const withTools = (
      base as typeof base & {
        bindTools?: (tools: unknown[]) => BaseChatModel
      }
    ).bindTools

    return withTools
      ? withTools.call(base, convertToolDefinitionsToLangChainTools(options.tools))
      : base
  }
}

function toLangChainMessages(messages: ChatMessage[]) {
  return messages.map((message) => toLangChainMessage(message))
}

async function ensureModelAvailable(
  kind: 'AI' | 'embedding',
  discover: (provider: string) => Promise<string[]>,
  provider: string,
  model: string,
) {
  const catalog = await discover(provider)
  if (!catalog.length) {
    throw new Error(`No model catalog available for ${kind} provider: ${provider}`)
  }
  if (!catalog.includes(model)) {
    throw new Error(`Model "${model}" is not available for ${kind} provider: ${provider}`)
  }
}

export async function createEmbeddingProvider(): Promise<EmbeddingProvider> {
  const provider = await settingsService.getEmbeddingProvider()
  const model = await settingsService.getEmbeddingModel()
  if (!model) throw new Error('No embedding model configured')
  await ensureModelAvailable('embedding', discoverEmbeddingModels, provider, model)

  const entry = embeddingRegistry.get(provider)
  if (!entry) throw new Error(`Unknown embedding provider: ${provider}`)

  const credential = await entry.resolve(provider)
  if (!credential) throw new Error(`No connection configured for embedding provider: ${provider}`)
  return entry.create(model, credential)
}

export async function createLLMForModel(provider: string, model: string): Promise<LLMProvider> {
  await ensureModelAvailable('AI', discoverLLMModels, provider, model)

  const entry = llmRegistry.get(provider)
  if (!entry) throw new Error(`Unknown AI provider: ${provider}`)

  const credential = await entry.resolve(provider)
  if (!credential) throw new Error(`No connection configured for AI provider: ${provider}`)
  return entry.create(model, credential)
}

function llmFactory(
  getSelection: () => Promise<{ provider: string; model: string | null }>,
): () => Promise<LLMProvider> {
  return async () => {
    const selection = await getSelection()
    if (!selection.model) {
      throw new Error('No AI model configured')
    }
    return createLLMForModel(selection.provider, selection.model)
  }
}

export const createLLMProvider = llmFactory(() => settingsService.getResolvedLLMRole('primary'))
export const createLightLLM = llmFactory(() => settingsService.getResolvedLLMRole('light'))
export const createTitleLLM = llmFactory(() => settingsService.getResolvedLLMRole('title'))
export const createCompactLLM = llmFactory(() => settingsService.getResolvedLLMRole('compact'))
export const createExploreLLM = llmFactory(() => settingsService.getResolvedLLMRole('explore'))
export const createExecuteLLM = llmFactory(() => settingsService.getResolvedLLMRole('execute'))
export const createMediumLLM = llmFactory(() => settingsService.getResolvedLLMRole('medium'))

export type { EmbeddingProvider } from './embeddings.interface.js'
export type {
  LLMProvider,
  ChatMessage,
  LLMOptions,
  LLMToolDefinition,
  LLMResponse,
  ToolCall,
  ToolResult,
} from './llm.interface.js'
