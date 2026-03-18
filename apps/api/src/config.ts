import { env } from './env.js'

export const MODEL_CATALOG = {
  llm: {
    openai: [
      'gpt-5.4',
      'gpt-5.4-pro',
      'gpt-5-mini',
      'gpt-5-nano',
      'gpt-5',
      'o4-mini',
      'o3',
      'o3-mini',
      'o3-pro',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
      'gpt-4o',
      'gpt-4o-mini',
    ],
    gemini: [
      'gemini-3.1-pro-preview',
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-pro',
    ],
    claude: [
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-20250514',
    ],
  } as Record<string, string[]>,
  embedding: {
    openai: ['text-embedding-3-small', 'text-embedding-3-large'],
    gemini: ['gemini-embedding-2-preview', 'gemini-embedding-001'],
  } as Record<string, string[]>,
}

export const DEFAULT_LLM_MODELS: Record<string, string> = {
  openai: 'gpt-5.4',
  gemini: 'gemini-2.5-flash',
  claude: 'claude-sonnet-4-6',
}

export const DEFAULT_EMBEDDING_MODELS: Record<string, string> = {
  openai: 'text-embedding-3-small',
  gemini: 'gemini-embedding-001',
}

export const DEFAULT_LIGHT_MODELS: Record<string, string> = {
  openai: 'gpt-5-mini',
  gemini: 'gemini-2.5-flash-lite',
  claude: 'claude-haiku-4-5-20251001',
}

export const DEFAULT_TITLE_MODELS: Record<string, string> = {
  openai: 'gpt-5-nano',
  gemini: 'gemini-3.1-flash-lite-preview',
  claude: 'claude-haiku-4-5-20251001',
}

export const DEFAULT_COMPACT_MODELS: Record<string, string> = {
  openai: 'gpt-5-nano',
  gemini: 'gemini-3.1-flash-lite-preview',
  claude: 'claude-haiku-4-5-20251001',
}

/** Infer the provider from a model ID based on naming conventions. */
export function inferProviderFromModel(modelId: string): string | null {
  if (modelId.startsWith('gpt-') || modelId.startsWith('o1') || modelId.startsWith('o3') || modelId.startsWith('o4')) return 'openai'
  if (modelId.startsWith('gemini-')) return 'gemini'
  if (modelId.startsWith('claude-')) return 'claude'
  return null
}

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
