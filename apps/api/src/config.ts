import { env } from './env.js'

/** Known providers that support LLM chat. */
export const LLM_PROVIDERS = ['openai', 'gemini', 'claude'] as const

/** Known providers that support embeddings. */
export const EMBEDDING_PROVIDERS = ['openai', 'gemini'] as const

/** Check if a model supports vision/multimodal input based on naming conventions. */
export function supportsVision(modelId: string): boolean {
  // o1 does not support vision; o3+ do
  if (modelId.startsWith('o1')) return false
  // All GPT-4+, Gemini, Claude, and o3/o4 models support vision
  if (modelId.startsWith('gpt-4') || modelId.startsWith('gpt-5')) return true
  if (/^o[3-9]/.test(modelId)) return true
  if (modelId.startsWith('gemini-')) return true
  if (modelId.startsWith('claude-')) return true
  return false
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
