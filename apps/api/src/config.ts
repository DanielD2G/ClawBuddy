import { env } from './env.js'

export interface ModelEntry {
  id: string
  supportsVision?: boolean
}

const v = (id: string): ModelEntry => ({ id, supportsVision: true })
const m = (id: string): ModelEntry => ({ id })

export const MODEL_CATALOG = {
  llm: {
    openai: [
      v('gpt-5.4'),
      v('gpt-5.4-pro'),
      v('gpt-5-mini'),
      v('gpt-5-nano'),
      v('gpt-5'),
      m('o4-mini'),
      m('o3'),
      m('o3-mini'),
      m('o3-pro'),
      v('gpt-4.1'),
      v('gpt-4.1-mini'),
      v('gpt-4.1-nano'),
      v('gpt-4o'),
      v('gpt-4o-mini'),
      v('gpt-4-turbo'),
    ],
    gemini: [
      v('gemini-3.1-pro-preview'),
      v('gemini-3-flash-preview'),
      v('gemini-3.1-flash-lite-preview'),
      v('gemini-2.5-flash'),
      v('gemini-2.5-flash-lite'),
      v('gemini-2.5-pro'),
    ],
    claude: [
      v('claude-opus-4-6'),
      v('claude-sonnet-4-6'),
      v('claude-haiku-4-5-20251001'),
      v('claude-sonnet-4-5-20250929'),
      v('claude-opus-4-5-20251101'),
      v('claude-sonnet-4-20250514'),
      v('claude-opus-4-0-20250514'),
    ],
    local: [] as ModelEntry[], // populated dynamically via model discovery
  } as Record<string, ModelEntry[]>,
  embedding: {
    openai: ['text-embedding-3-small', 'text-embedding-3-large'],
    gemini: ['gemini-embedding-2-preview', 'gemini-embedding-001'],
  } as Record<string, string[]>,
}

/** Helper to extract plain model ID strings from an LLM catalog entry. */
export function catalogModelIds(provider: string): string[] {
  return (MODEL_CATALOG.llm[provider] ?? []).map((e) => e.id)
}

/** Models known to support vision/multimodal input, derived from the catalog. */
export const VISION_MODELS = new Set(
  Object.values(MODEL_CATALOG.llm)
    .flatMap((models) => models)
    .filter((e) => e.supportsVision)
    .map((e) => e.id),
)

export const DEFAULT_LLM_MODELS: Record<string, string> = {
  openai: 'gpt-5.4',
  gemini: 'gemini-2.5-flash',
  claude: 'claude-sonnet-4-6',
  local: 'default',
}

export const DEFAULT_EMBEDDING_MODELS: Record<string, string> = {
  openai: 'text-embedding-3-small',
  gemini: 'gemini-embedding-001',
}

export const DEFAULT_MEDIUM_MODELS: Record<string, string> = {
  openai: 'gpt-5-mini',
  gemini: 'gemini-2.5-flash',
  claude: 'claude-sonnet-4-6',
  local: 'default',
}

export const DEFAULT_LIGHT_MODELS: Record<string, string> = {
  openai: 'gpt-5-nano',
  gemini: 'gemini-2.5-flash-lite',
  claude: 'claude-haiku-4-5-20251001',
  local: 'default',
}

export const DEFAULT_TITLE_MODELS: Record<string, string> = {
  openai: 'gpt-5-nano',
  gemini: 'gemini-3.1-flash-lite-preview',
  claude: 'claude-haiku-4-5-20251001',
  local: 'default',
}

export const DEFAULT_COMPACT_MODELS: Record<string, string> = {
  openai: 'gpt-5-nano',
  gemini: 'gemini-3.1-flash-lite-preview',
  claude: 'claude-haiku-4-5-20251001',
  local: 'default',
}

/** Infer the provider from a model ID based on naming conventions. */
export function inferProviderFromModel(modelId: string): string | null {
  if (
    modelId.startsWith('gpt-') ||
    modelId.startsWith('o1') ||
    modelId.startsWith('o3') ||
    modelId.startsWith('o4')
  )
    return 'openai'
  if (modelId.startsWith('gemini-')) return 'gemini'
  if (modelId.startsWith('claude-')) return 'claude'
  // Local models cannot be inferred by prefix — they are matched by the
  // caller when the model exists in the local catalog.
  return null
}

/** Default base URL for local OpenAI-compatible servers. */
export const DEFAULT_LOCAL_BASE_URL = 'http://localhost:1234'

export const ENV_KEYS: Record<string, string> = {
  openai: env.OPENAI_API_KEY,
  gemini: env.GEMINI_API_KEY,
  claude: env.ANTHROPIC_API_KEY,
}

export const DB_KEY_FIELDS: Record<string, 'openaiApiKey' | 'geminiApiKey' | 'anthropicApiKey'> = {
  openai: 'openaiApiKey',
  gemini: 'geminiApiKey',
  claude: 'anthropicApiKey',
}
