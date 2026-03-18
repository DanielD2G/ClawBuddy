import { settingsService } from '../services/settings.service.js'
import { inferProviderFromModel } from '../config.js'
import type { EmbeddingProvider } from './embeddings.interface.js'
import type { LLMProvider } from './llm.interface.js'

export async function createEmbeddingProvider(): Promise<EmbeddingProvider> {
  const provider = await settingsService.getEmbeddingProvider()
  const model = await settingsService.getEmbeddingModel()
  const apiKey = await settingsService.getApiKey(provider)
  if (!apiKey) throw new Error(`No API key configured for embedding provider: ${provider}`)

  switch (provider) {
    case 'openai': {
      const { OpenAIEmbeddingProvider } = require('./openai-embeddings.js')
      return new OpenAIEmbeddingProvider(model, apiKey)
    }
    case 'gemini': {
      const { GeminiEmbeddingProvider } = require('./gemini-embeddings.js')
      return new GeminiEmbeddingProvider(model, apiKey)
    }
    default:
      throw new Error(`Unknown embedding provider: ${provider}`)
  }
}

async function createLLMForModel(model: string): Promise<LLMProvider> {
  // Infer provider from the model name; fall back to the global aiProvider setting
  const provider = inferProviderFromModel(model) ?? (await settingsService.getAIProvider())
  const apiKey = await settingsService.getApiKey(provider)
  if (!apiKey) throw new Error(`No API key configured for AI provider: ${provider}`)

  switch (provider) {
    case 'openai': {
      const { OpenAILLMProvider } = require('./openai-llm.js')
      return new OpenAILLMProvider(model, apiKey)
    }
    case 'gemini': {
      const { GeminiLLMProvider } = require('./gemini-llm.js')
      return new GeminiLLMProvider(model, apiKey)
    }
    case 'claude': {
      const { ClaudeLLMProvider } = require('./claude-llm.js')
      return new ClaudeLLMProvider(model, apiKey)
    }
    default:
      throw new Error(`Unknown AI provider: ${provider}`)
  }
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
