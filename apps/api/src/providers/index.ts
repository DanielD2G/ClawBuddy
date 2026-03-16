import { settingsService } from '../services/settings.service.js'
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
  const provider = await settingsService.getAIProvider()
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

export async function createLLMProvider(): Promise<LLMProvider> {
  const model = await settingsService.getAIModel()
  return createLLMForModel(model)
}

export async function createLightLLM(): Promise<LLMProvider> {
  const model = await settingsService.getLightModel()
  return createLLMForModel(model)
}

export async function createTitleLLM(): Promise<LLMProvider> {
  const model = await settingsService.getTitleModel()
  return createLLMForModel(model)
}

export async function createCompactLLM(): Promise<LLMProvider> {
  const model = await settingsService.getCompactModel()
  return createLLMForModel(model)
}

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
