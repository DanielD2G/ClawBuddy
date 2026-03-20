import { ValidationError, ConfigurationError } from '../lib/errors.js'
import { prisma } from '../lib/prisma.js'
import { env } from '../env.js'
import { encrypt, decrypt } from './crypto.service.js'
import {
  MODEL_CATALOG,
  DEFAULT_LLM_MODELS,
  DEFAULT_EMBEDDING_MODELS,
  DEFAULT_MEDIUM_MODELS,
  DEFAULT_LIGHT_MODELS,
  DEFAULT_LOCAL_BASE_URL,
  ENV_KEYS,
  DB_KEY_FIELDS,
  inferProviderFromModel,
} from '../config.js'
import { discoverLLMModels, discoverEmbeddingModels } from './model-discovery.service.js'
import {
  DEFAULT_CONTEXT_LIMIT_TOKENS,
  DEFAULT_BROWSER_GRID_URL,
  DEFAULT_BROWSER_TYPE,
  MIN_CONTEXT_LIMIT_TOKENS,
  MAX_CONTEXT_LIMIT_TOKENS,
  KEY_MASK_THRESHOLD,
  DEFAULT_MAX_AGENT_ITERATIONS,
  SUB_AGENT_EXPLORE_MAX_ITERATIONS,
  SUB_AGENT_ANALYZE_MAX_ITERATIONS,
  SUB_AGENT_EXECUTE_MAX_ITERATIONS,
} from '../constants.js'
import type { AppSettings } from '@prisma/client'

let _cache: AppSettings | null = null
let _cacheTime = 0
const CACHE_TTL_MS = 30_000

export const settingsService = {
  _invalidateCache() {
    _cache = null
    _cacheTime = 0
  },

  async get() {
    if (_cache && Date.now() - _cacheTime < CACHE_TTL_MS) return _cache
    const settings = await prisma.appSettings.findUnique({ where: { id: 'singleton' } })
    if (settings) {
      _cache = settings
      _cacheTime = Date.now()
      return settings
    }
    const created = await prisma.appSettings.create({
      data: {
        id: 'singleton',
        aiProvider: env.AI_PROVIDER,
        embeddingProvider: env.EMBEDDING_PROVIDER,
      },
    })
    _cache = created
    _cacheTime = Date.now()
    return created
  },

  async getAIProvider(): Promise<string> {
    return (await this.get()).aiProvider
  },

  async getEmbeddingProvider(): Promise<string> {
    return (await this.get()).embeddingProvider
  },

  async getAIModel(): Promise<string> {
    const s = await this.get()
    return s.aiModel ?? DEFAULT_LLM_MODELS[s.aiProvider] ?? DEFAULT_LLM_MODELS.openai
  },

  async getLightModel(): Promise<string> {
    return this._resolveModel('lightModel', null, DEFAULT_LIGHT_MODELS)
  },

  async getTitleModel(): Promise<string> {
    return this._resolveModel('titleModel', 'lightModel', DEFAULT_LIGHT_MODELS)
  },

  async getCompactModel(): Promise<string> {
    return this._resolveModel('compactModel', 'mediumModel', DEFAULT_MEDIUM_MODELS)
  },

  async getMediumModel(): Promise<string> {
    return this._resolveModel('mediumModel', null, DEFAULT_MEDIUM_MODELS)
  },

  async getAdvancedModelConfig(): Promise<boolean> {
    return (await this.get()).advancedModelConfig
  },

  async getExploreModel(): Promise<string> {
    return this._resolveModel('exploreModel', 'lightModel', DEFAULT_LIGHT_MODELS)
  },

  async getExecuteModel(): Promise<string> {
    return this._resolveModel('executeModel', 'mediumModel', DEFAULT_MEDIUM_MODELS)
  },

  /**
   * Resolve a model by key with optional advanced-mode override and tier fallback.
   * - If advancedModelConfig is on and the model key has a value, use it directly.
   * - Otherwise, fall back to the tier's model → provider default → openai default.
   */
  async _resolveModel(
    modelKey: string,
    fallbackTierKey: string | null,
    defaults: Record<string, string>,
  ): Promise<string> {
    const s = await this.get()
    const settings = s as Record<string, unknown>
    if (fallbackTierKey && s.advancedModelConfig && settings[modelKey]) {
      return settings[modelKey] as string
    }
    const tierKey = fallbackTierKey ?? modelKey
    const tierValue = settings[tierKey] as string | null | undefined
    return tierValue ?? defaults[s.aiProvider] ?? defaults.openai
  },

  async getEmbeddingModel(): Promise<string> {
    const s = await this.get()
    return (
      s.embeddingModel ??
      DEFAULT_EMBEDDING_MODELS[s.embeddingProvider] ??
      DEFAULT_EMBEDDING_MODELS.openai
    )
  },

  async getContextLimitTokens(): Promise<number> {
    return this._getNumericSetting('contextLimitTokens', DEFAULT_CONTEXT_LIMIT_TOKENS)
  },

  async getTimezone(): Promise<string> {
    const s = await this.get()
    return s.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  },

  async getMaxAgentIterations(): Promise<number> {
    return this._getNumericSetting('maxAgentIterations', DEFAULT_MAX_AGENT_ITERATIONS)
  },

  async _getNumericSetting(key: string, fallback: number): Promise<number> {
    const s = await this.get()
    return ((s as Record<string, unknown>)[key] as number) ?? fallback
  },

  async getSubAgentExploreMaxIterations(): Promise<number> {
    return this._getNumericSetting('subAgentExploreMaxIterations', SUB_AGENT_EXPLORE_MAX_ITERATIONS)
  },

  async getSubAgentAnalyzeMaxIterations(): Promise<number> {
    return this._getNumericSetting('subAgentAnalyzeMaxIterations', SUB_AGENT_ANALYZE_MAX_ITERATIONS)
  },

  async getSubAgentExecuteMaxIterations(): Promise<number> {
    return this._getNumericSetting('subAgentExecuteMaxIterations', SUB_AGENT_EXECUTE_MAX_ITERATIONS)
  },

  async getLocalBaseUrl(): Promise<string> {
    const envUrl = env.LOCAL_MODEL_BASE_URL
    if (envUrl) return envUrl
    const s = await this.get()
    return (s as Record<string, unknown>).ollamaBaseUrl as string ?? DEFAULT_LOCAL_BASE_URL
  },

  async isLocalServerConfigured(): Promise<boolean> {
    const baseUrl = await this.getLocalBaseUrl()
    try {
      const normalized = baseUrl.replace(/\/+$/, '')
      const url = normalized.endsWith('/v1') ? `${normalized}/models` : `${normalized}/v1/models`
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
      return res.ok
    } catch {
      return false
    }
  },

  async getBrowserGridUrl(): Promise<string> {
    const envUrl = process.env.BROWSER_GRID_URL
    if (envUrl) return envUrl
    const s = await this.get()
    return ((s as Record<string, unknown>).browserGridUrl as string) ?? DEFAULT_BROWSER_GRID_URL
  },

  async getBrowserGridApiKey(): Promise<string | null> {
    const envKey = process.env.BROWSER_GRID_API_KEY
    if (envKey) return envKey
    const s = await this.get()
    const encrypted = (s as Record<string, unknown>).browserGridApiKey as string | null
    if (!encrypted) return null
    try {
      return decrypt(encrypted)
    } catch {
      return null
    }
  },

  async getBrowserGridBrowser(): Promise<string> {
    const s = await this.get()
    return ((s as Record<string, unknown>).browserGridBrowser as string) ?? DEFAULT_BROWSER_TYPE
  },

  async getBrowserModel(): Promise<string | null> {
    const s = await this.get()
    return ((s as Record<string, unknown>).browserModel as string | null) ?? null
  },

  async getApiKey(provider: string): Promise<string | null> {
    // Local provider doesn't need an API key — return a dummy value so callers see it as "configured"
    if (provider === 'local') return 'local'
    // Env takes priority
    if (ENV_KEYS[provider]) return ENV_KEYS[provider]
    // Check DB
    const field = DB_KEY_FIELDS[provider]
    if (!field) return null
    const s = await this.get()
    const encrypted = s[field]
    if (!encrypted) return null
    try {
      return decrypt(encrypted)
    } catch {
      return null
    }
  },

  async setApiKey(provider: string, plaintext: string) {
    const field = DB_KEY_FIELDS[provider]
    if (!field) throw new ConfigurationError(`Unknown provider: ${provider}`)
    await this.get() // ensure row exists
    const value = plaintext.trim() ? encrypt(plaintext.trim()) : null
    const result = await prisma.appSettings.update({
      where: { id: 'singleton' },
      data: { [field]: value },
    })
    this._invalidateCache()
    return result
  },

  async removeApiKey(provider: string) {
    const field = DB_KEY_FIELDS[provider]
    if (!field) throw new ConfigurationError(`Unknown provider: ${provider}`)
    const result = await prisma.appSettings.update({
      where: { id: 'singleton' },
      data: { [field]: null },
    })
    this._invalidateCache()
    return result
  },

  async getAvailableProviders() {
    const s = await this.get()
    const checkKey = (provider: string) => {
      if (provider === 'local') return false // handled separately below
      if (ENV_KEYS[provider]) return true
      const field = DB_KEY_FIELDS[provider]
      return field ? !!s[field] : false
    }
    const llmProviders = Object.keys(MODEL_CATALOG.llm).filter(checkKey)

    // Local is available if explicitly configured (env or DB) or reachable at default URL
    const localUrl = (s as Record<string, unknown>).ollamaBaseUrl as string | null
    if (env.LOCAL_MODEL_BASE_URL || localUrl) {
      llmProviders.push('local')
    } else {
      // Auto-detect: probe the default local server URL
      const localReachable = await this.isLocalServerConfigured()
      if (localReachable) llmProviders.push('local')
    }

    return {
      llm: llmProviders,
      embedding: Object.keys(MODEL_CATALOG.embedding).filter(checkKey),
    }
  },

  async getMaskedKeys() {
    const s = await this.get()
    const result: Record<string, { source: 'env' | 'db' | null; masked: string | null }> = {}
    for (const provider of ['openai', 'gemini', 'claude']) {
      const envKey = ENV_KEYS[provider]
      if (envKey) {
        result[provider] = { source: 'env', masked: mask(envKey) }
      } else {
        const field = DB_KEY_FIELDS[provider]
        const encrypted = field ? s[field] : null
        if (encrypted) {
          try {
            result[provider] = { source: 'db', masked: mask(decrypt(encrypted)) }
          } catch {
            result[provider] = { source: null, masked: null }
          }
        } else {
          result[provider] = { source: null, masked: null }
        }
      }
    }
    // Local provider doesn't use API keys — report the base URL instead
    const localUrl = (s as Record<string, unknown>).ollamaBaseUrl as string | null
    if (env.LOCAL_MODEL_BASE_URL) {
      result.local = { source: 'env', masked: env.LOCAL_MODEL_BASE_URL }
    } else if (localUrl) {
      result.local = { source: 'db', masked: localUrl }
    } else {
      result.local = { source: null, masked: null }
    }
    return result
  },

  async getGoogleCredentials(): Promise<{ clientId: string; clientSecret: string } | null> {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null
    return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
  },

  isGoogleOAuthConfigured(): boolean {
    return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
  },

  async completeOnboarding() {
    await this.get() // ensure row exists
    const result = await prisma.appSettings.update({
      where: { id: 'singleton' },
      data: { onboardingComplete: true },
    })
    this._invalidateCache()
    return result
  },

  async setBrowserGridApiKey(plaintext: string) {
    await this.get()
    const value = plaintext.trim() ? encrypt(plaintext.trim()) : null
    const result = await prisma.appSettings.update({
      where: { id: 'singleton' },
      data: { browserGridApiKey: value },
    })
    this._invalidateCache()
    return result
  },

  async update(data: {
    aiProvider?: string
    aiModel?: string
    mediumModel?: string
    lightModel?: string
    exploreModel?: string
    executeModel?: string
    titleModel?: string
    compactModel?: string
    useLightModel?: boolean
    advancedModelConfig?: boolean
    embeddingProvider?: string
    embeddingModel?: string
    contextLimitTokens?: number
    ollamaBaseUrl?: string
    browserGridUrl?: string
    browserGridBrowser?: string
    browserModel?: string
    maxAgentIterations?: number
    subAgentExploreMaxIterations?: number
    subAgentAnalyzeMaxIterations?: number
    subAgentExecuteMaxIterations?: number
    timezone?: string
  }) {
    const settings = await this.get()
    const available = await this.getAvailableProviders()

    // Lock embedding settings after onboarding
    if (settings.onboardingComplete && (data.embeddingProvider || data.embeddingModel)) {
      throw new ValidationError('Embedding model cannot be changed after initial setup')
    }

    if (data.aiProvider && data.aiProvider !== 'local' && !available.llm.includes(data.aiProvider)) {
      throw new ValidationError(`AI provider "${data.aiProvider}" is not available (no API key)`)
    }
    if (data.embeddingProvider && !available.embedding.includes(data.embeddingProvider)) {
      throw new ValidationError(
        `Embedding provider "${data.embeddingProvider}" is not available (no API key)`,
      )
    }

    // Validate each model against its inferred provider (supports mixed providers per role)
    const defaultProvider = data.aiProvider ?? settings.aiProvider

    // Pre-fetch local models so we can check membership for models with unknown prefixes
    let localModels: string[] | null = null
    if (available.llm.includes('local')) {
      localModels = await discoverLLMModels('local')
    }

    for (const field of [
      'aiModel',
      'mediumModel',
      'lightModel',
      'exploreModel',
      'executeModel',
      'titleModel',
      'compactModel',
    ] as const) {
      const modelId = data[field]
      if (!modelId) continue

      // Infer provider: first try by prefix, then check if it's a known local model
      let modelProvider = inferProviderFromModel(modelId)
      if (!modelProvider && localModels?.includes(modelId)) {
        modelProvider = 'local'
      }
      modelProvider ??= defaultProvider

      // Verify the provider has an API key (local doesn't need one)
      if (modelProvider !== 'local') {
        const hasKey = available.llm.includes(modelProvider)
        if (!hasKey) {
          throw new Error(
            `No API key configured for provider "${modelProvider}" (model "${modelId}")`,
          )
        }
      }
      const llmModels = modelProvider === 'local' && localModels
        ? localModels
        : await discoverLLMModels(modelProvider)
      if (llmModels.length && !llmModels.includes(modelId)) {
        throw new Error(`Model "${modelId}" is not available for provider "${modelProvider}"`)
      }
    }

    if (data.embeddingModel && data.embeddingProvider) {
      const models = await discoverEmbeddingModels(data.embeddingProvider)
      if (models.length && !models.includes(data.embeddingModel)) {
        throw new Error(
          `Model "${data.embeddingModel}" is not available for provider "${data.embeddingProvider}"`,
        )
      }
    }

    if (data.contextLimitTokens !== undefined) {
      if (
        data.contextLimitTokens < MIN_CONTEXT_LIMIT_TOKENS ||
        data.contextLimitTokens > MAX_CONTEXT_LIMIT_TOKENS
      ) {
        throw new ValidationError(
          `Context limit must be between ${MIN_CONTEXT_LIMIT_TOKENS.toLocaleString()} and ${MAX_CONTEXT_LIMIT_TOKENS.toLocaleString()} tokens`,
        )
      }
    }

    await this.get() // ensure row exists
    const result = await prisma.appSettings.update({
      where: { id: 'singleton' },
      data,
    })
    this._invalidateCache()
    return result
  },
}

function mask(key: string): string {
  if (key.length <= KEY_MASK_THRESHOLD) return '****'
  return '****' + key.slice(-4)
}
