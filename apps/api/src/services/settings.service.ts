import type { Prisma } from '@prisma/client'
import { ValidationError, ConfigurationError } from '../lib/errors.js'
import { prisma } from '../lib/prisma.js'
import { env } from '../env.js'
import { encrypt, decrypt } from './crypto.service.js'
import {
  LLM_PROVIDERS,
  EMBEDDING_PROVIDERS,
  ENV_KEYS,
  ENV_BASE_URLS,
  DB_KEY_FIELDS,
  PROVIDER_METADATA,
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
import {
  buildResolvedRoleProviders,
  mergeLLMProviderOverrides,
  resolveAllLLMRoles,
  resolveLLMRole,
  type LLMRole,
} from '../lib/llm-resolver.js'

type AppSettingsRecord = NonNullable<Awaited<ReturnType<typeof prisma.appSettings.findUnique>>>

let _cache: AppSettingsRecord | null = null
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
    return s.aiModel!
  },

  async getResolvedLLMRole(role: LLMRole): Promise<{ provider: string; model: string | null }> {
    return resolveLLMRole(await this.get(), role)
  },

  async getResolvedRoleProviders(): Promise<Record<LLMRole, string>> {
    return buildResolvedRoleProviders(await this.get())
  },

  async getLightModel(): Promise<string> {
    return this._resolveModel('lightModel', null)
  },

  async getTitleModel(): Promise<string> {
    return this._resolveModel('titleModel', 'lightModel')
  },

  async getCompactModel(): Promise<string> {
    return this._resolveModel('compactModel', 'mediumModel')
  },

  async getMediumModel(): Promise<string> {
    return this._resolveModel('mediumModel', null)
  },

  async getAdvancedModelConfig(): Promise<boolean> {
    return (await this.get()).advancedModelConfig
  },

  async getExploreModel(): Promise<string> {
    return this._resolveModel('exploreModel', 'lightModel')
  },

  async getExecuteModel(): Promise<string> {
    return this._resolveModel('executeModel', 'mediumModel')
  },

  /**
   * Resolve a model by key with optional advanced-mode override and tier fallback.
   * Falls back to the main AI model if the specific tier model is not set.
   */
  async _resolveModel(modelKey: string, fallbackTierKey: string | null): Promise<string> {
    const s = await this.get()
    const settings = s as Record<string, unknown>
    if (fallbackTierKey && s.advancedModelConfig && settings[modelKey]) {
      return settings[modelKey] as string
    }
    const tierKey = fallbackTierKey ?? modelKey
    const tierValue = settings[tierKey] as string | null | undefined
    return tierValue ?? s.aiModel!
  },

  async getEmbeddingModel(): Promise<string> {
    const s = await this.get()
    return s.embeddingModel!
  },

  async getContextLimitTokens(): Promise<number> {
    return this._getNumericSetting('contextLimitTokens', DEFAULT_CONTEXT_LIMIT_TOKENS)
  },

  async getTimezone(): Promise<string> {
    const s = await this.get()
    return s.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  },

  async getDismissedUpdateVersion(): Promise<string | null> {
    const s = await this.get()
    return s.dismissedUpdateVersion ?? null
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

  async getLocalBaseUrl(): Promise<string | null> {
    const envBaseUrl = ENV_BASE_URLS.local?.trim()
    if (envBaseUrl) return envBaseUrl
    const s = await this.get()
    return s.localBaseUrl?.trim() || null
  },

  async getProviderConnectionValue(provider: string): Promise<string | null> {
    if (provider === 'local') return this.getLocalBaseUrl()
    return this.getApiKey(provider)
  },

  async isProviderConfigured(provider: string): Promise<boolean> {
    const value = await this.getProviderConnectionValue(provider)
    return !!value?.trim()
  },

  async getConfiguredProviders() {
    const [llmChecks, embeddingChecks] = await Promise.all([
      Promise.all(
        LLM_PROVIDERS.map(async (provider) => ({
          provider,
          configured: await this.isProviderConfigured(provider),
        })),
      ),
      Promise.all(
        EMBEDDING_PROVIDERS.map(async (provider) => ({
          provider,
          configured: await this.isProviderConfigured(provider),
        })),
      ),
    ])

    return {
      llm: llmChecks.filter((entry) => entry.configured).map((entry) => entry.provider),
      embedding: embeddingChecks.filter((entry) => entry.configured).map((entry) => entry.provider),
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

  async setProviderConnection(provider: string, plaintext: string) {
    const trimmed = plaintext.trim()
    if (!trimmed) throw new ValidationError('Connection value cannot be empty')

    if (provider === 'local') {
      await this.get()
      const result = await prisma.appSettings.update({
        where: { id: 'singleton' },
        data: { localBaseUrl: trimmed },
      })
      this._invalidateCache()
      return result
    }

    return this.setApiKey(provider, trimmed)
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

  async removeProviderConnection(provider: string) {
    if (provider === 'local') {
      const result = await prisma.appSettings.update({
        where: { id: 'singleton' },
        data: { localBaseUrl: null },
      })
      this._invalidateCache()
      return result
    }

    return this.removeApiKey(provider)
  },

  async getAvailableProviders() {
    const configured = await this.getConfiguredProviders()
    const [llmChecks, embeddingChecks] = await Promise.all([
      Promise.all(
        configured.llm.map(async (provider) => ({
          provider,
          models: await discoverLLMModels(provider),
        })),
      ),
      Promise.all(
        configured.embedding.map(async (provider) => ({
          provider,
          models: await discoverEmbeddingModels(provider),
        })),
      ),
    ])

    return {
      llm: llmChecks.filter((entry) => entry.models.length > 0).map((entry) => entry.provider),
      embedding: embeddingChecks
        .filter((entry) => entry.models.length > 0)
        .map((entry) => entry.provider),
    }
  },

  getProviderMetadata() {
    return PROVIDER_METADATA
  },

  async getProviderConnections() {
    const s = await this.get()
    const result: Record<string, { source: 'env' | 'db' | null; value: string | null }> = {}

    for (const provider of Object.keys(PROVIDER_METADATA)) {
      const envKey = ENV_KEYS[provider]
      if (envKey) {
        result[provider] = { source: 'env', value: mask(envKey) }
        continue
      }

      const envBaseUrl = ENV_BASE_URLS[provider]
      if (envBaseUrl) {
        result[provider] = { source: 'env', value: envBaseUrl }
        continue
      }

      const field = DB_KEY_FIELDS[provider]
      const encrypted = field ? s[field] : null
      if (encrypted) {
        try {
          result[provider] = { source: 'db', value: mask(decrypt(encrypted)) }
        } catch {
          result[provider] = { source: null, value: null }
        }
        continue
      }

      if (provider === 'local' && s.localBaseUrl) {
        result[provider] = { source: 'db', value: s.localBaseUrl }
        continue
      }

      result[provider] = { source: null, value: null }
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

  async setDismissedUpdateVersion(version: string | null) {
    await this.get()
    const result = await prisma.appSettings.update({
      where: { id: 'singleton' },
      data: { dismissedUpdateVersion: version?.trim() || null },
    })
    this._invalidateCache()
    return result
  },

  async update(data: {
    aiProvider?: string
    aiModel?: string | null
    mediumModel?: string | null
    lightModel?: string | null
    exploreModel?: string | null
    executeModel?: string | null
    titleModel?: string | null
    compactModel?: string | null
    roleProviders?: Partial<Record<LLMRole, string>>
    useLightModel?: boolean
    advancedModelConfig?: boolean
    embeddingProvider?: string
    embeddingModel?: string | null
    contextLimitTokens?: number
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
    const nextSettings: AppSettingsRecord = {
      ...settings,
      ...(data.aiProvider !== undefined ? { aiProvider: data.aiProvider } : {}),
      ...(data.aiModel !== undefined ? { aiModel: data.aiModel } : {}),
      ...(data.mediumModel !== undefined ? { mediumModel: data.mediumModel } : {}),
      ...(data.lightModel !== undefined ? { lightModel: data.lightModel } : {}),
      ...(data.exploreModel !== undefined ? { exploreModel: data.exploreModel } : {}),
      ...(data.executeModel !== undefined ? { executeModel: data.executeModel } : {}),
      ...(data.titleModel !== undefined ? { titleModel: data.titleModel } : {}),
      ...(data.compactModel !== undefined ? { compactModel: data.compactModel } : {}),
      ...(data.advancedModelConfig !== undefined
        ? { advancedModelConfig: data.advancedModelConfig }
        : {}),
      ...(data.embeddingProvider !== undefined
        ? { embeddingProvider: data.embeddingProvider }
        : {}),
      ...(data.embeddingModel !== undefined ? { embeddingModel: data.embeddingModel } : {}),
      llmProviderOverrides: data.roleProviders
        ? mergeLLMProviderOverrides(settings.llmProviderOverrides, data.roleProviders)
        : settings.llmProviderOverrides,
    }

    // Lock embedding settings after onboarding
    if (settings.onboardingComplete && (data.embeddingProvider || data.embeddingModel)) {
      throw new ValidationError('Embedding model cannot be changed after initial setup')
    }

    if (
      nextSettings.aiProvider &&
      !available.llm.includes(nextSettings.aiProvider as (typeof LLM_PROVIDERS)[number])
    ) {
      throw new ValidationError(
        `AI provider "${nextSettings.aiProvider}" is not available (missing catalog or connection)`,
      )
    }
    if (
      nextSettings.embeddingProvider &&
      !available.embedding.includes(
        nextSettings.embeddingProvider as (typeof EMBEDDING_PROVIDERS)[number],
      )
    ) {
      throw new ValidationError(
        `Embedding provider "${nextSettings.embeddingProvider}" is not available (missing catalog or connection)`,
      )
    }

    const resolvedRoles = resolveAllLLMRoles(nextSettings)
    for (const [role, selection] of Object.entries(resolvedRoles)) {
      if (!selection.model) continue
      if (!available.llm.includes(selection.provider as (typeof LLM_PROVIDERS)[number])) {
        throw new ValidationError(
          `Provider "${selection.provider}" is not available for role "${role}"`,
        )
      }
      const llmModels = await discoverLLMModels(selection.provider)
      if (!llmModels.length) {
        throw new ValidationError(
          `Provider "${selection.provider}" has no available catalog for role "${role}"`,
        )
      }
      if (!llmModels.includes(selection.model)) {
        throw new ValidationError(
          `Model "${selection.model}" is not available for provider "${selection.provider}"`,
        )
      }
    }

    if (nextSettings.embeddingModel && nextSettings.embeddingProvider) {
      const models = await discoverEmbeddingModels(nextSettings.embeddingProvider)
      if (!models.length) {
        throw new ValidationError(
          `Embedding provider "${nextSettings.embeddingProvider}" has no available catalog`,
        )
      }
      if (!models.includes(nextSettings.embeddingModel)) {
        throw new ValidationError(
          `Model "${nextSettings.embeddingModel}" is not available for provider "${nextSettings.embeddingProvider}"`,
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
    const { roleProviders, ...persistedData } = data
    const updatePayload = {
      ...persistedData,
      ...(roleProviders
        ? { llmProviderOverrides: nextSettings.llmProviderOverrides as Record<string, unknown> }
        : {}),
    }
    const result = await prisma.appSettings.update({
      where: { id: 'singleton' },
      data: updatePayload as Prisma.AppSettingsUpdateInput,
    })
    this._invalidateCache()
    return result
  },
}

function mask(key: string): string {
  if (key.length <= KEY_MASK_THRESHOLD) return '****'
  return '****' + key.slice(-4)
}
