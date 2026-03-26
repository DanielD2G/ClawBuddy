import { describe, expect, test, vi, beforeEach } from 'vitest'

// Mock all provider constructors and settings/discovery services
vi.mock('../services/settings.service.js', () => ({
  settingsService: {
    getApiKey: vi.fn(),
    getLocalBaseUrl: vi.fn(),
    getEmbeddingProvider: vi.fn(),
    getEmbeddingModel: vi.fn(),
    getResolvedLLMRole: vi.fn(),
  },
}))

vi.mock('../services/model-discovery.service.js', () => ({
  discoverLLMModels: vi.fn(),
  discoverEmbeddingModels: vi.fn(),
}))

vi.mock('./openai-llm.js', () => ({
  OpenAILLMProvider: vi.fn().mockImplementation((model: string) => ({
    modelId: model,
    providerId: 'openai',
  })),
}))

vi.mock('./claude-llm.js', () => ({
  ClaudeLLMProvider: vi.fn().mockImplementation((model: string) => ({
    modelId: model,
    providerId: 'claude',
  })),
}))

vi.mock('./gemini-llm.js', () => ({
  GeminiLLMProvider: vi.fn().mockImplementation((model: string) => ({
    modelId: model,
    providerId: 'gemini',
  })),
}))

vi.mock('./local-llm.js', () => ({
  LocalLLMProvider: vi.fn().mockImplementation((model: string) => ({
    modelId: model,
    providerId: 'local',
  })),
}))

vi.mock('./openai-embeddings.js', () => ({
  OpenAIEmbeddingProvider: vi.fn().mockImplementation((model: string) => ({
    model,
    provider: 'openai',
  })),
}))

vi.mock('./gemini-embeddings.js', () => ({
  GeminiEmbeddingProvider: vi.fn().mockImplementation((model: string) => ({
    model,
    provider: 'gemini',
  })),
}))

vi.mock('./local-embeddings.js', () => ({
  LocalEmbeddingProvider: vi.fn().mockImplementation((model: string) => ({
    model,
    provider: 'local',
  })),
}))

import { settingsService } from '../services/settings.service.js'
import { discoverLLMModels, discoverEmbeddingModels } from '../services/model-discovery.service.js'
import {
  createLLMProvider,
  createLLMForModel,
  createEmbeddingProvider,
  createTitleLLM,
} from './index.js'

const mockSettings = vi.mocked(settingsService)
const mockDiscoverLLM = vi.mocked(discoverLLMModels)
const mockDiscoverEmbedding = vi.mocked(discoverEmbeddingModels)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createLLMForModel', () => {
  test('creates OpenAI provider', async () => {
    mockDiscoverLLM.mockResolvedValue(['gpt-5.4'])
    mockSettings.getApiKey.mockResolvedValue('sk-test')

    const provider = await createLLMForModel('openai', 'gpt-5.4')
    expect(provider.providerId).toBe('openai')
    expect(provider.modelId).toBe('gpt-5.4')
  })

  test('creates Claude provider', async () => {
    mockDiscoverLLM.mockResolvedValue(['claude-sonnet-4-6'])
    mockSettings.getApiKey.mockResolvedValue('sk-ant-test')

    const provider = await createLLMForModel('claude', 'claude-sonnet-4-6')
    expect(provider.providerId).toBe('claude')
    expect(provider.modelId).toBe('claude-sonnet-4-6')
  })

  test('creates Gemini provider', async () => {
    mockDiscoverLLM.mockResolvedValue(['gemini-2.5-flash'])
    mockSettings.getApiKey.mockResolvedValue('gemini-key')

    const provider = await createLLMForModel('gemini', 'gemini-2.5-flash')
    expect(provider.providerId).toBe('gemini')
    expect(provider.modelId).toBe('gemini-2.5-flash')
  })

  test('creates Local provider', async () => {
    mockDiscoverLLM.mockResolvedValue(['llama3'])
    mockSettings.getLocalBaseUrl.mockResolvedValue('http://localhost:11434')

    const provider = await createLLMForModel('local', 'llama3')
    expect(provider.providerId).toBe('local')
    expect(provider.modelId).toBe('llama3')
  })

  test('throws for unknown provider', async () => {
    mockDiscoverLLM.mockResolvedValue(['some-model'])

    await expect(createLLMForModel('unknown-provider', 'some-model')).rejects.toThrow(
      'Unknown AI provider: unknown-provider',
    )
  })

  test('throws when model is not in catalog', async () => {
    mockDiscoverLLM.mockResolvedValue(['gpt-5.4'])
    mockSettings.getApiKey.mockResolvedValue('sk-test')

    await expect(createLLMForModel('openai', 'nonexistent-model')).rejects.toThrow(
      'Model "nonexistent-model" is not available',
    )
  })

  test('throws when no credential is configured', async () => {
    mockDiscoverLLM.mockResolvedValue(['gpt-5.4'])
    mockSettings.getApiKey.mockResolvedValue(null)

    await expect(createLLMForModel('openai', 'gpt-5.4')).rejects.toThrow(
      'No connection configured for AI provider: openai',
    )
  })

  test('throws when catalog is empty', async () => {
    mockDiscoverLLM.mockResolvedValue([])

    await expect(createLLMForModel('openai', 'gpt-5.4')).rejects.toThrow(
      'No model catalog available',
    )
  })
})

describe('createEmbeddingProvider', () => {
  test('creates OpenAI embedding provider', async () => {
    mockSettings.getEmbeddingProvider.mockResolvedValue('openai')
    mockSettings.getEmbeddingModel.mockResolvedValue('text-embedding-3-small')
    mockDiscoverEmbedding.mockResolvedValue(['text-embedding-3-small'])
    mockSettings.getApiKey.mockResolvedValue('sk-test')

    const provider = await createEmbeddingProvider()
    expect(provider).toBeDefined()
  })

  test('creates Gemini embedding provider', async () => {
    mockSettings.getEmbeddingProvider.mockResolvedValue('gemini')
    mockSettings.getEmbeddingModel.mockResolvedValue('gemini-embedding-001')
    mockDiscoverEmbedding.mockResolvedValue(['gemini-embedding-001'])
    mockSettings.getApiKey.mockResolvedValue('gemini-key')

    const provider = await createEmbeddingProvider()
    expect(provider).toBeDefined()
  })

  test('creates Local embedding provider', async () => {
    mockSettings.getEmbeddingProvider.mockResolvedValue('local')
    mockSettings.getEmbeddingModel.mockResolvedValue('nomic-embed')
    mockDiscoverEmbedding.mockResolvedValue(['nomic-embed'])
    mockSettings.getLocalBaseUrl.mockResolvedValue('http://localhost:11434')

    const provider = await createEmbeddingProvider()
    expect(provider).toBeDefined()
  })

  test('throws when no embedding model configured', async () => {
    mockSettings.getEmbeddingProvider.mockResolvedValue('openai')
    mockSettings.getEmbeddingModel.mockResolvedValue(null)

    await expect(createEmbeddingProvider()).rejects.toThrow('No embedding model configured')
  })

  test('throws for unknown embedding provider', async () => {
    mockSettings.getEmbeddingProvider.mockResolvedValue('unknown')
    mockSettings.getEmbeddingModel.mockResolvedValue('some-model')
    mockDiscoverEmbedding.mockResolvedValue(['some-model'])

    await expect(createEmbeddingProvider()).rejects.toThrow('Unknown embedding provider: unknown')
  })
})

describe('createLLMProvider (primary role)', () => {
  test('uses primary role settings', async () => {
    mockSettings.getResolvedLLMRole.mockResolvedValue({
      provider: 'openai',
      model: 'gpt-5.4',
    })
    mockDiscoverLLM.mockResolvedValue(['gpt-5.4'])
    mockSettings.getApiKey.mockResolvedValue('sk-test')

    const provider = await createLLMProvider()
    expect(provider.providerId).toBe('openai')
    expect(mockSettings.getResolvedLLMRole).toHaveBeenCalledWith('primary')
  })
})

describe('createTitleLLM', () => {
  test('uses title role settings', async () => {
    mockSettings.getResolvedLLMRole.mockResolvedValue({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    })
    mockDiscoverLLM.mockResolvedValue(['claude-sonnet-4-6'])
    mockSettings.getApiKey.mockResolvedValue('sk-ant-test')

    const provider = await createTitleLLM()
    expect(provider.providerId).toBe('claude')
    expect(mockSettings.getResolvedLLMRole).toHaveBeenCalledWith('title')
  })

  test('throws when no model configured for role', async () => {
    mockSettings.getResolvedLLMRole.mockResolvedValue({
      provider: 'openai',
      model: null,
    })

    await expect(createTitleLLM()).rejects.toThrow('No AI model configured')
  })
})
