import { settingsService } from '../services/settings.service.js'
import { discoverEmbeddingModels, discoverLLMModels } from '../services/model-discovery.service.js'
import type { EmbeddingProvider } from './embeddings.interface.js'
import type { LLMProvider } from './llm.interface.js'
import { OpenAIEmbeddingProvider } from './openai-embeddings.js'
import { GeminiEmbeddingProvider } from './gemini-embeddings.js'
import { LocalEmbeddingProvider } from './local-embeddings.js'
import { OpenAILLMProvider } from './openai-llm.js'
import { GeminiLLMProvider } from './gemini-llm.js'
import { ClaudeLLMProvider } from './claude-llm.js'
import { LocalLLMProvider } from './local-llm.js'

type ProviderCredentialResolver = (provider: string) => Promise<string | null>

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
      create: (model, credential) => new OpenAIEmbeddingProvider(model, credential ?? undefined),
      resolve: (provider) => settingsService.getApiKey(provider),
    },
  ],
  [
    'gemini',
    {
      create: (model, credential) => new GeminiEmbeddingProvider(model, credential ?? ''),
      resolve: (provider) => settingsService.getApiKey(provider),
    },
  ],
  [
    'local',
    {
      create: (model, credential) => new LocalEmbeddingProvider(model, credential ?? ''),
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
      create: (model, credential) => new OpenAILLMProvider(model, credential ?? undefined),
      resolve: (provider) => settingsService.getApiKey(provider),
    },
  ],
  [
    'gemini',
    {
      create: (model, credential) => new GeminiLLMProvider(model, credential ?? ''),
      resolve: (provider) => settingsService.getApiKey(provider),
    },
  ],
  [
    'claude',
    {
      create: (model, credential) => new ClaudeLLMProvider(model, credential ?? ''),
      resolve: (provider) => settingsService.getApiKey(provider),
    },
  ],
  [
    'local',
    {
      create: (model, credential) => new LocalLLMProvider(model, credential ?? ''),
      resolve: () => settingsService.getLocalBaseUrl(),
    },
  ],
])

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
