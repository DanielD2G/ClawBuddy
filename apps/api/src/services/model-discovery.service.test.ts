import { describe, expect, test, vi, beforeEach } from 'vitest'

// ── Mocks ───────────────────────────────────────────────────────────────

vi.mock('./settings.service.js', () => ({
  settingsService: {
    getProviderConnectionValue: vi.fn().mockResolvedValue(null),
  },
}))

vi.mock('../providers/openai-compatible.js', () => ({
  listOpenAICompatibleModels: vi.fn().mockResolvedValue([]),
}))

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      models: {
        list: vi.fn().mockResolvedValue({
          data: [{ id: 'claude-3-opus' }, { id: 'claude-3-sonnet' }],
        }),
      },
    })),
  }
})

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  testProviderConnection,
  discoverLLMModels,
  discoverEmbeddingModels,
  buildModelCatalogs,
  invalidateModelCache,
} from './model-discovery.service.js'
import { listOpenAICompatibleModels } from '../providers/openai-compatible.js'
import { settingsService } from './settings.service.js'

const mockSettingsService = vi.mocked(settingsService)

describe('model-discovery.service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Always invalidate caches between tests
    invalidateModelCache()
  })

  // ── testProviderConnection ────────────────────────────────────────────

  describe('testProviderConnection', () => {
    test('returns invalid when connection value is empty', async () => {
      const result = await testProviderConnection('openai', '')
      expect(result.valid).toBe(false)
      expect(result.reachable).toBe(false)
      expect(result.message).toBe('Connection value is required')
    })

    test('returns invalid when connection value is whitespace', async () => {
      const result = await testProviderConnection('openai', '   ')
      expect(result.valid).toBe(false)
      expect(result.message).toBe('Connection value is required')
    })

    test('returns valid when provider returns models', async () => {
      vi.mocked(listOpenAICompatibleModels).mockResolvedValueOnce([
        'gpt-4o',
        'gpt-4o-mini',
        'text-embedding-3-small',
      ])

      const result = await testProviderConnection('openai', 'sk-test-key')
      expect(result.valid).toBe(true)
      expect(result.reachable).toBe(true)
      expect(result.llmModels).toContain('gpt-4o')
      expect(result.embeddingModels).toContain('text-embedding-3-small')
    })

    test('filters out non-chat models for OpenAI', async () => {
      vi.mocked(listOpenAICompatibleModels).mockResolvedValueOnce([
        'gpt-4o',
        'dall-e-3',
        'whisper-1',
        'gpt-4o-realtime',
        'tts-1',
        'text-embedding-3-small',
      ])

      const result = await testProviderConnection('openai', 'sk-test-key')
      expect(result.llmModels).toEqual(['gpt-4o'])
      expect(result.llmModels).not.toContain('dall-e-3')
      expect(result.llmModels).not.toContain('whisper-1')
    })

    test('returns reachable but invalid when no models returned', async () => {
      vi.mocked(listOpenAICompatibleModels).mockResolvedValueOnce([])

      const result = await testProviderConnection('openai', 'sk-test-key')
      expect(result.valid).toBe(false)
      expect(result.reachable).toBe(true)
      expect(result.message).toBe('Connection succeeded but no models were returned')
    })

    test('returns unreachable on API error', async () => {
      vi.mocked(listOpenAICompatibleModels).mockRejectedValueOnce(new Error('Network error'))

      const result = await testProviderConnection('openai', 'sk-test-key')
      expect(result.valid).toBe(false)
      expect(result.reachable).toBe(false)
      expect(result.message).toBe('Network error')
    })

    test('handles unknown provider gracefully', async () => {
      const result = await testProviderConnection('unknown-provider', 'some-key')
      expect(result.valid).toBe(false)
      expect(result.reachable).toBe(true)
      expect(result.llmModels).toEqual([])
    })

    test('tests anthropic provider connection', async () => {
      const result = await testProviderConnection('claude', 'sk-ant-test')
      expect(result.valid).toBe(true)
      expect(result.reachable).toBe(true)
      expect(result.llmModels).toContain('claude-3-opus')
      expect(result.embeddingModels).toEqual([])
    })
  })

  // ── discoverLLMModels ─────────────────────────────────────────────────

  describe('discoverLLMModels', () => {
    test('returns empty array when no connection value configured', async () => {
      mockSettingsService.getProviderConnectionValue.mockResolvedValueOnce(null)
      const models = await discoverLLMModels('openai')
      expect(models).toEqual([])
    })

    test('fetches and caches models', async () => {
      mockSettingsService.getProviderConnectionValue.mockResolvedValue('sk-test')
      vi.mocked(listOpenAICompatibleModels).mockResolvedValue(['gpt-4o', 'gpt-4o-mini'])

      const first = await discoverLLMModels('openai')
      expect(first).toContain('gpt-4o')

      // Second call should use cache (no new API call)
      vi.mocked(listOpenAICompatibleModels).mockClear()
      const second = await discoverLLMModels('openai')
      expect(second).toEqual(first)
      expect(listOpenAICompatibleModels).not.toHaveBeenCalled()
    })

    test('returns empty array on API failure', async () => {
      mockSettingsService.getProviderConnectionValue.mockResolvedValueOnce('sk-test')
      vi.mocked(listOpenAICompatibleModels).mockRejectedValueOnce(new Error('API down'))

      const models = await discoverLLMModels('openai')
      expect(models).toEqual([])
    })
  })

  // ── discoverEmbeddingModels ───────────────────────────────────────────

  describe('discoverEmbeddingModels', () => {
    test('returns empty array when no connection value', async () => {
      mockSettingsService.getProviderConnectionValue.mockResolvedValueOnce(null)
      const models = await discoverEmbeddingModels('openai')
      expect(models).toEqual([])
    })

    test('fetches embedding models', async () => {
      mockSettingsService.getProviderConnectionValue.mockResolvedValue('sk-test')
      vi.mocked(listOpenAICompatibleModels).mockResolvedValue([
        'gpt-4o',
        'text-embedding-3-small',
        'text-embedding-3-large',
      ])

      const models = await discoverEmbeddingModels('openai')
      expect(models).toContain('text-embedding-3-small')
      expect(models).toContain('text-embedding-3-large')
      expect(models).not.toContain('gpt-4o')
    })

    test('returns empty array on API failure', async () => {
      mockSettingsService.getProviderConnectionValue.mockResolvedValueOnce('sk-test')
      vi.mocked(listOpenAICompatibleModels).mockRejectedValueOnce(new Error('timeout'))

      const models = await discoverEmbeddingModels('openai')
      expect(models).toEqual([])
    })
  })

  // ── invalidateModelCache ──────────────────────────────────────────────

  describe('invalidateModelCache', () => {
    test('clears cache for specific provider', async () => {
      mockSettingsService.getProviderConnectionValue.mockResolvedValue('sk-test')
      vi.mocked(listOpenAICompatibleModels).mockResolvedValue(['gpt-4o'])

      await discoverLLMModels('openai')
      vi.mocked(listOpenAICompatibleModels).mockClear()

      invalidateModelCache('openai')

      // After invalidation, should fetch again
      vi.mocked(listOpenAICompatibleModels).mockResolvedValue(['gpt-4o'])
      await discoverLLMModels('openai')
      expect(listOpenAICompatibleModels).toHaveBeenCalled()
    })

    test('clears all caches when no provider specified', async () => {
      mockSettingsService.getProviderConnectionValue.mockResolvedValue('sk-test')
      vi.mocked(listOpenAICompatibleModels).mockResolvedValue(['gpt-4o'])

      await discoverLLMModels('openai')
      invalidateModelCache()

      vi.mocked(listOpenAICompatibleModels).mockClear()
      vi.mocked(listOpenAICompatibleModels).mockResolvedValue(['gpt-4o'])
      await discoverLLMModels('openai')
      expect(listOpenAICompatibleModels).toHaveBeenCalled()
    })
  })

  // ── buildModelCatalogs ────────────────────────────────────────────────

  describe('buildModelCatalogs', () => {
    test('builds catalogs for multiple providers', async () => {
      mockSettingsService.getProviderConnectionValue.mockResolvedValue('sk-test')
      vi.mocked(listOpenAICompatibleModels).mockResolvedValue(['gpt-4o', 'text-embedding-3-small'])

      const catalogs = await buildModelCatalogs({
        llm: ['openai'],
        embedding: ['openai'],
      })

      expect(catalogs.llm).toHaveProperty('openai')
      expect(catalogs.embedding).toHaveProperty('openai')
      expect(catalogs.llm.openai).toContain('gpt-4o')
    })

    test('returns empty arrays for providers with no models', async () => {
      mockSettingsService.getProviderConnectionValue.mockResolvedValue(null)

      const catalogs = await buildModelCatalogs({
        llm: ['openai'],
        embedding: [],
      })

      expect(catalogs.llm.openai).toEqual([])
      expect(catalogs.embedding).toEqual({})
    })
  })
})
