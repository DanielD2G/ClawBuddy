import { prisma } from '../lib/prisma.js'
import { env } from '../env.js'
import { encrypt, decrypt } from './crypto.service.js'
import {
  MODEL_CATALOG,
  DEFAULT_LLM_MODELS,
  DEFAULT_EMBEDDING_MODELS,
  DEFAULT_LIGHT_MODELS,
  DEFAULT_TITLE_MODELS,
  DEFAULT_COMPACT_MODELS,
  ENV_KEYS,
  DB_KEY_FIELDS,
} from '../config.js'
import {
  DEFAULT_CONTEXT_LIMIT_TOKENS,
  DEFAULT_BROWSER_GRID_URL,
  DEFAULT_BROWSER_TYPE,
  MIN_CONTEXT_LIMIT_TOKENS,
  MAX_CONTEXT_LIMIT_TOKENS,
  KEY_MASK_THRESHOLD,
  DEFAULT_MAX_AGENT_ITERATIONS,
} from '../constants.js'

export { MODEL_CATALOG }

export const settingsService = {
  async get() {
    const settings = await prisma.appSettings.findUnique({ where: { id: 'singleton' } })
    if (settings) return settings
    return prisma.appSettings.create({
      data: {
        id: 'singleton',
        aiProvider: env.AI_PROVIDER,
        embeddingProvider: env.EMBEDDING_PROVIDER,
      },
    })
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
    const s = await this.get()
    return s.lightModel ?? DEFAULT_LIGHT_MODELS[s.aiProvider] ?? DEFAULT_LIGHT_MODELS.openai
  },

  async getTitleModel(): Promise<string> {
    const s = await this.get()
    return s.titleModel ?? DEFAULT_TITLE_MODELS[s.aiProvider] ?? DEFAULT_TITLE_MODELS.openai
  },

  async getCompactModel(): Promise<string> {
    const s = await this.get()
    return s.compactModel ?? DEFAULT_COMPACT_MODELS[s.aiProvider] ?? DEFAULT_COMPACT_MODELS.openai
  },

  async getUseLightModel(): Promise<boolean> {
    return (await this.get()).useLightModel
  },

  async getEmbeddingModel(): Promise<string> {
    const s = await this.get()
    return s.embeddingModel ?? DEFAULT_EMBEDDING_MODELS[s.embeddingProvider] ?? DEFAULT_EMBEDDING_MODELS.openai
  },

  async getContextLimitTokens(): Promise<number> {
    const s = await this.get()
    return (s as Record<string, unknown>).contextLimitTokens as number ?? DEFAULT_CONTEXT_LIMIT_TOKENS
  },

  async getMaxAgentIterations(): Promise<number> {
    const s = await this.get()
    return (s as Record<string, unknown>).maxAgentIterations as number ?? DEFAULT_MAX_AGENT_ITERATIONS
  },

  async getBrowserGridUrl(): Promise<string> {
    const envUrl = process.env.BROWSER_GRID_URL
    if (envUrl) return envUrl
    const s = await this.get()
    return (s as Record<string, unknown>).browserGridUrl as string ?? DEFAULT_BROWSER_GRID_URL
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
    return (s as Record<string, unknown>).browserGridBrowser as string ?? DEFAULT_BROWSER_TYPE
  },

  async getBrowserModel(): Promise<string | null> {
    const s = await this.get()
    return (s as Record<string, unknown>).browserModel as string | null ?? null
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

  async setApiKey(provider: string, plaintext: string) {
    const field = DB_KEY_FIELDS[provider]
    if (!field) throw new Error(`Unknown provider: ${provider}`)
    await this.get() // ensure row exists
    const value = plaintext.trim() ? encrypt(plaintext.trim()) : null
    return prisma.appSettings.update({
      where: { id: 'singleton' },
      data: { [field]: value },
    })
  },

  async removeApiKey(provider: string) {
    const field = DB_KEY_FIELDS[provider]
    if (!field) throw new Error(`Unknown provider: ${provider}`)
    return prisma.appSettings.update({
      where: { id: 'singleton' },
      data: { [field]: null },
    })
  },

  async getAvailableProviders() {
    const s = await this.get()
    const checkKey = (provider: string) => {
      if (ENV_KEYS[provider]) return true
      const field = DB_KEY_FIELDS[provider]
      return field ? !!s[field] : false
    }
    return {
      llm: Object.keys(MODEL_CATALOG.llm).filter(checkKey),
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
    return prisma.appSettings.update({
      where: { id: 'singleton' },
      data: { onboardingComplete: true },
    })
  },

  async setBrowserGridApiKey(plaintext: string) {
    await this.get()
    const value = plaintext.trim() ? encrypt(plaintext.trim()) : null
    return prisma.appSettings.update({
      where: { id: 'singleton' },
      data: { browserGridApiKey: value },
    })
  },

  async update(data: {
    aiProvider?: string
    aiModel?: string
    lightModel?: string
    titleModel?: string
    compactModel?: string
    useLightModel?: boolean
    embeddingProvider?: string
    embeddingModel?: string
    contextLimitTokens?: number
    browserGridUrl?: string
    browserGridBrowser?: string
    browserModel?: string
    maxAgentIterations?: number
  }) {
    const settings = await this.get()
    const available = await this.getAvailableProviders()

    // Lock embedding settings after onboarding
    if (settings.onboardingComplete && (data.embeddingProvider || data.embeddingModel)) {
      throw new Error('Embedding model cannot be changed after initial setup')
    }

    if (data.aiProvider && !available.llm.includes(data.aiProvider)) {
      throw new Error(`AI provider "${data.aiProvider}" is not available (no API key)`)
    }
    if (data.embeddingProvider && !available.embedding.includes(data.embeddingProvider)) {
      throw new Error(`Embedding provider "${data.embeddingProvider}" is not available (no API key)`)
    }

    // Validate all model fields against catalog
    const provider = data.aiProvider ?? settings.aiProvider
    const llmModels = MODEL_CATALOG.llm[provider] ?? []
    for (const field of ['aiModel', 'lightModel', 'titleModel', 'compactModel'] as const) {
      if (data[field] && llmModels.length && !llmModels.includes(data[field]!)) {
        throw new Error(`Model "${data[field]}" is not available for provider "${provider}"`)
      }
    }

    if (data.embeddingModel && data.embeddingProvider) {
      const models = MODEL_CATALOG.embedding[data.embeddingProvider]
      if (models && !models.includes(data.embeddingModel)) {
        throw new Error(`Model "${data.embeddingModel}" is not available for provider "${data.embeddingProvider}"`)
      }
    }

    if (data.contextLimitTokens !== undefined) {
      if (data.contextLimitTokens < MIN_CONTEXT_LIMIT_TOKENS || data.contextLimitTokens > MAX_CONTEXT_LIMIT_TOKENS) {
        throw new Error(`Context limit must be between ${MIN_CONTEXT_LIMIT_TOKENS.toLocaleString()} and ${MAX_CONTEXT_LIMIT_TOKENS.toLocaleString()} tokens`)
      }
    }

    await this.get() // ensure row exists
    return prisma.appSettings.update({
      where: { id: 'singleton' },
      data,
    })
  },
}

function mask(key: string): string {
  if (key.length <= KEY_MASK_THRESHOLD) return '****'
  return '****' + key.slice(-4)
}
