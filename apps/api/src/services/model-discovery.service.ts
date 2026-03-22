import { ChatAnthropic } from '@langchain/anthropic'
import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import { ChatOpenAI } from '@langchain/openai'
import { settingsService } from './settings.service.js'

const CACHE_TTL_MS = 5 * 60 * 1000

const STATIC_MODEL_CATALOG = {
  openai: {
    llm: ['gpt-5.4', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'],
    embedding: ['text-embedding-3-large', 'text-embedding-3-small'],
  },
  claude: {
    llm: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'],
    embedding: [],
  },
  gemini: {
    llm: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    embedding: ['gemini-embedding-001'],
  },
} as const

interface CacheEntry {
  models: string[]
  fetchedAt: number
}

export interface ProviderConnectionTestResult {
  valid: boolean
  reachable: boolean
  llmModels: string[]
  embeddingModels: string[]
  message?: string
}

const llmCache = new Map<string, CacheEntry>()
const embeddingCache = new Map<string, CacheEntry>()

function getCached(cache: Map<string, CacheEntry>, key: string): string[] | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return entry.models
}

function normalizeLocalBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  if (!normalized) return ''
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`
}

async function listOpenAICompatibleModels(connectionValue: string) {
  const baseUrl = normalizeLocalBaseUrl(connectionValue)
  const response = await fetch(`${baseUrl}/models`, {
    headers: {
      Authorization: 'Bearer local',
      'Content-Type': 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error(`Local provider returned ${response.status}`)
  }

  const data = (await response.json()) as {
    data?: Array<{ id?: string }>
  }

  return (data.data ?? [])
    .map((entry) => entry.id?.trim())
    .filter((id): id is string => Boolean(id))
}

async function fetchProviderModels(
  provider: string,
  connectionValue: string,
): Promise<{ llm: string[]; embedding: string[] }> {
  if (provider === 'local') {
    const llm = await listOpenAICompatibleModels(connectionValue)
    return { llm, embedding: llm }
  }

  const staticCatalog = STATIC_MODEL_CATALOG[provider as keyof typeof STATIC_MODEL_CATALOG] ?? null
  if (!staticCatalog) return { llm: [], embedding: [] }
  return {
    llm: [...staticCatalog.llm],
    embedding: [...staticCatalog.embedding],
  }
}

async function assertProviderReachable(provider: string, connectionValue: string) {
  switch (provider) {
    case 'openai': {
      const model = STATIC_MODEL_CATALOG.openai.llm[0]
      const client = new ChatOpenAI({
        model,
        apiKey: connectionValue,
        maxRetries: 0,
        maxTokens: 1,
      })
      await client.invoke('ping')
      return
    }
    case 'claude': {
      const model = STATIC_MODEL_CATALOG.claude.llm[0]
      const client = new ChatAnthropic({
        model,
        apiKey: connectionValue,
        maxRetries: 0,
        maxTokens: 1,
      })
      await client.invoke('ping')
      return
    }
    case 'gemini': {
      const model = STATIC_MODEL_CATALOG.gemini.llm[0]
      const client = new ChatGoogleGenerativeAI({
        model,
        apiKey: connectionValue,
        maxRetries: 0,
        maxOutputTokens: 1,
      })
      await client.invoke('ping')
      return
    }
    case 'local':
      await listOpenAICompatibleModels(connectionValue)
      return
    default:
      throw new Error(`Unknown provider: ${provider}`)
  }
}

export async function testProviderConnection(
  provider: string,
  connectionValue: string,
): Promise<ProviderConnectionTestResult> {
  const trimmed = connectionValue.trim()
  if (!trimmed) {
    return {
      valid: false,
      reachable: false,
      llmModels: [],
      embeddingModels: [],
      message: 'Connection value is required',
    }
  }

  try {
    await assertProviderReachable(provider, trimmed)
    const result = await fetchProviderModels(provider, trimmed)
    const hasModels = result.llm.length > 0 || result.embedding.length > 0

    return {
      valid: hasModels,
      reachable: true,
      llmModels: result.llm,
      embeddingModels: result.embedding,
      ...(hasModels ? {} : { message: 'Connection succeeded but no models were returned' }),
    }
  } catch (err) {
    return {
      valid: false,
      reachable: false,
      llmModels: [],
      embeddingModels: [],
      message: err instanceof Error ? err.message : 'Failed to reach provider',
    }
  }
}

export async function discoverLLMModels(provider: string): Promise<string[]> {
  const cached = getCached(llmCache, provider)
  if (cached) return cached

  try {
    const connectionValue = await settingsService.getProviderConnectionValue(provider)
    if (!connectionValue) return []

    const result = await fetchProviderModels(provider, connectionValue)
    llmCache.set(provider, { models: result.llm, fetchedAt: Date.now() })
    embeddingCache.set(provider, { models: result.embedding, fetchedAt: Date.now() })
    return result.llm
  } catch (err) {
    console.warn(
      `[model-discovery] Failed to fetch models for ${provider}:`,
      err instanceof Error ? err.message : err,
    )
    return []
  }
}

export async function discoverEmbeddingModels(provider: string): Promise<string[]> {
  const cached = getCached(embeddingCache, provider)
  if (cached) return cached

  try {
    const connectionValue = await settingsService.getProviderConnectionValue(provider)
    if (!connectionValue) return []

    const result = await fetchProviderModels(provider, connectionValue)
    llmCache.set(provider, { models: result.llm, fetchedAt: Date.now() })
    embeddingCache.set(provider, { models: result.embedding, fetchedAt: Date.now() })
    return result.embedding
  } catch (err) {
    console.warn(
      `[model-discovery] Failed to fetch embedding models for ${provider}:`,
      err instanceof Error ? err.message : err,
    )
    return []
  }
}

export async function buildModelCatalogs(available: {
  llm: string[]
  embedding: string[]
}): Promise<{
  llm: Record<string, string[]>
  embedding: Record<string, string[]>
}> {
  const [llmEntries, embeddingEntries] = await Promise.all([
    Promise.all(
      available.llm.map(async (provider) => [provider, await discoverLLMModels(provider)]),
    ),
    Promise.all(
      available.embedding.map(async (provider) => [
        provider,
        await discoverEmbeddingModels(provider),
      ]),
    ),
  ])

  return {
    llm: Object.fromEntries(llmEntries) as Record<string, string[]>,
    embedding: Object.fromEntries(embeddingEntries) as Record<string, string[]>,
  }
}

export function invalidateModelCache(provider?: string) {
  if (!provider) {
    llmCache.clear()
    embeddingCache.clear()
    return
  }

  llmCache.delete(provider)
  embeddingCache.delete(provider)
}
