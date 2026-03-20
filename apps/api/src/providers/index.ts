import { settingsService } from '../services/settings.service.js'
import { inferProviderFromModel } from '../config.js'
import type { EmbeddingProvider } from './embeddings.interface.js'
import type { LLMProvider } from './llm.interface.js'
import { OpenAIEmbeddingProvider } from './openai-embeddings.js'
import { GeminiEmbeddingProvider } from './gemini-embeddings.js'
import { OpenAILLMProvider } from './openai-llm.js'
import { GeminiLLMProvider } from './gemini-llm.js'
import { ClaudeLLMProvider } from './claude-llm.js'
import { LocalLLMProvider } from './local-llm.js'

const embeddingRegistry = new Map<string, new (model: string, apiKey: string) => EmbeddingProvider>(
  [
    ['openai', OpenAIEmbeddingProvider],
    ['gemini', GeminiEmbeddingProvider],
  ],
)

const llmRegistry = new Map<string, new (model: string, apiKey: string) => LLMProvider>([
  ['openai', OpenAILLMProvider],
  ['gemini', GeminiLLMProvider],
  ['claude', ClaudeLLMProvider],
])

export async function createEmbeddingProvider(): Promise<EmbeddingProvider> {
  const provider = await settingsService.getEmbeddingProvider()
  const model = await settingsService.getEmbeddingModel()
  const apiKey = await settingsService.getApiKey(provider)
  if (!apiKey) throw new Error(`No API key configured for embedding provider: ${provider}`)

  const Provider = embeddingRegistry.get(provider)
  if (!Provider) throw new Error(`Unknown embedding provider: ${provider}`)
  return new Provider(model, apiKey)
}

export async function createLLMForModel(model: string): Promise<LLMProvider> {
  // Infer provider from the model name
  let provider = inferProviderFromModel(model)

  // If we can't infer by prefix, check if it's a known local model or if global provider is local
  if (!provider) {
    const globalProvider = await settingsService.getAIProvider()
    if (globalProvider === 'local') {
      provider = 'local'
    } else {
      // Check if this model exists in the local catalog (mixed provider scenario)
      const { discoverLLMModels } = await import('../services/model-discovery.service.js')
      const available = await settingsService.getAvailableProviders()
      if (available.llm.includes('local')) {
        const localModels = await discoverLLMModels('local')
        if (localModels.includes(model)) {
          provider = 'local'
        }
      }
    }
    provider ??= globalProvider
  }

  // Local provider — uses OpenAI-compatible API with custom baseURL, no API key
  if (provider === 'local') {
    const baseUrl = await settingsService.getLocalBaseUrl()
    return new LocalLLMProvider(model, baseUrl)
  }

  const apiKey = await settingsService.getApiKey(provider)
  if (!apiKey) throw new Error(`No API key configured for AI provider: ${provider}`)

  const Provider = llmRegistry.get(provider)
  if (!Provider) throw new Error(`Unknown AI provider: ${provider}`)
  return new Provider(model, apiKey)
}

function llmFactory(getModel: () => Promise<string>): () => Promise<LLMProvider> {
  return () => getModel().then(createLLMForModel)
}

export const createLLMProvider = llmFactory(() => settingsService.getAIModel())
export const createLightLLM = llmFactory(() => settingsService.getLightModel())
export const createTitleLLM = llmFactory(() => settingsService.getTitleModel())
export const createCompactLLM = llmFactory(() => settingsService.getCompactModel())
export const createExploreLLM = llmFactory(() => settingsService.getExploreModel())
export const createExecuteLLM = llmFactory(() => settingsService.getExecuteModel())
export const createMediumLLM = llmFactory(() => settingsService.getMediumModel())

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
