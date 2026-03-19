import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { MODEL_CATALOG, catalogModelIds } from '../config.js'
import { settingsService } from './settings.service.js'

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

interface CacheEntry {
  models: string[]
  fetchedAt: number
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

// ── OpenAI ───────────────────────────────────────────

const OPENAI_CHAT_PREFIXES = ['gpt-', 'o1', 'o3', 'o4']
const OPENAI_CHAT_EXCLUDES = [
  'realtime',
  'audio',
  'search',
  'transcribe',
  'tts',
  'dall-e',
  'whisper',
  'instruct',
  '-codex',
  'moderation',
  'gpt-image',
  'chatgpt-image',
  'gpt-oss',
]
const OPENAI_EMBEDDING_PREFIXES = ['text-embedding-']

async function fetchOpenAIModels(apiKey: string): Promise<{ llm: string[]; embedding: string[] }> {
  const client = new OpenAI({ apiKey })
  const list = await client.models.list()
  const all: string[] = []
  for await (const model of list) {
    all.push(model.id)
  }
  return {
    llm: all
      .filter((id) => OPENAI_CHAT_PREFIXES.some((p) => id.startsWith(p)))
      .filter((id) => !OPENAI_CHAT_EXCLUDES.some((ex) => id.includes(ex)))
      .sort(),
    embedding: all.filter((id) => OPENAI_EMBEDDING_PREFIXES.some((p) => id.startsWith(p))).sort(),
  }
}

// ── Anthropic ────────────────────────────────────────

async function fetchAnthropicModels(apiKey: string): Promise<{ llm: string[] }> {
  const client = new Anthropic({ apiKey })
  const list = await client.models.list({ limit: 100 })
  const models = list.data.map((m) => m.id).sort()
  return { llm: models }
}

// ── Gemini ───────────────────────────────────────────

const GEMINI_LLM_EXCLUDES = [
  'image',
  'tts',
  'robotics',
  'computer-use',
  'deep-research',
  'nano-banana',
  'gemma',
  'customtools',
  'learnlm',
]

interface GeminiModel {
  name: string
  supportedGenerationMethods: string[]
}

interface GeminiListResponse {
  models: GeminiModel[]
  nextPageToken?: string
}

async function fetchGeminiModels(apiKey: string): Promise<{ llm: string[]; embedding: string[] }> {
  const allModels: GeminiModel[] = []
  let pageToken: string | undefined

  do {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models')
    url.searchParams.set('key', apiKey)
    url.searchParams.set('pageSize', '100')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const res = await fetch(url.toString())
    if (!res.ok) throw new Error(`Gemini API returned ${res.status}`)
    const data = (await res.json()) as GeminiListResponse
    allModels.push(...(data.models ?? []))
    pageToken = data.nextPageToken
  } while (pageToken)

  const stripPrefix = (name: string) => name.replace(/^models\//, '')

  return {
    llm: allModels
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => stripPrefix(m.name))
      .filter((id) => !GEMINI_LLM_EXCLUDES.some((ex) => id.includes(ex)))
      .sort(),
    embedding: allModels
      .filter((m) => m.supportedGenerationMethods?.includes('embedContent'))
      .map((m) => stripPrefix(m.name))
      .sort(),
  }
}

// ── Public API ───────────────────────────────────────

async function fetchAndCache(
  provider: string,
  apiKey: string,
): Promise<{ llm: string[]; embedding: string[] }> {
  switch (provider) {
    case 'openai':
      return fetchOpenAIModels(apiKey)
    case 'claude':
      return { ...(await fetchAnthropicModels(apiKey)), embedding: [] }
    case 'gemini':
      return fetchGeminiModels(apiKey)
    default:
      return { llm: [], embedding: [] }
  }
}

export async function discoverLLMModels(provider: string): Promise<string[]> {
  const cached = getCached(llmCache, provider)
  if (cached) return cached

  try {
    const apiKey = await settingsService.getApiKey(provider)
    if (!apiKey) return catalogModelIds(provider)

    const result = await fetchAndCache(provider, apiKey)

    // Cache both
    llmCache.set(provider, { models: result.llm, fetchedAt: Date.now() })
    if (result.embedding.length) {
      embeddingCache.set(provider, { models: result.embedding, fetchedAt: Date.now() })
    }

    return result.llm.length ? result.llm : catalogModelIds(provider)
  } catch (err) {
    console.warn(
      `[model-discovery] Failed to fetch models for ${provider}:`,
      err instanceof Error ? err.message : err,
    )
    return catalogModelIds(provider)
  }
}

export async function discoverEmbeddingModels(provider: string): Promise<string[]> {
  const cached = getCached(embeddingCache, provider)
  if (cached) return cached

  try {
    const apiKey = await settingsService.getApiKey(provider)
    if (!apiKey) return MODEL_CATALOG.embedding[provider] ?? []

    const result = await fetchAndCache(provider, apiKey)

    // Cache both
    if (result.llm.length) {
      llmCache.set(provider, { models: result.llm, fetchedAt: Date.now() })
    }
    embeddingCache.set(provider, { models: result.embedding, fetchedAt: Date.now() })

    return result.embedding.length ? result.embedding : (MODEL_CATALOG.embedding[provider] ?? [])
  } catch (err) {
    console.warn(
      `[model-discovery] Failed to fetch embedding models for ${provider}:`,
      err instanceof Error ? err.message : err,
    )
    return MODEL_CATALOG.embedding[provider] ?? []
  }
}

/** Build a full model catalog keyed by provider for both LLM and embedding. */
export async function buildModelCatalogs(available: {
  llm: string[]
  embedding: string[]
}): Promise<{
  llm: Record<string, string[]>
  embedding: Record<string, string[]>
}> {
  const [llmEntries, embeddingEntries] = await Promise.all([
    Promise.all(available.llm.map(async (p) => [p, await discoverLLMModels(p)] as const)),
    Promise.all(
      available.embedding.map(async (p) => [p, await discoverEmbeddingModels(p)] as const),
    ),
  ])
  return {
    llm: Object.fromEntries(llmEntries) as Record<string, string[]>,
    embedding: Object.fromEntries(embeddingEntries) as Record<string, string[]>,
  }
}

/** Invalidate cache for a provider (e.g. after API key change) */
export function invalidateModelCache(provider?: string) {
  if (provider) {
    llmCache.delete(provider)
    embeddingCache.delete(provider)
  } else {
    llmCache.clear()
    embeddingCache.clear()
  }
}
