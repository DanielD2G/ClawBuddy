import { env } from './env.js'

/** Known providers that support LLM chat. */
export const LLM_PROVIDERS = ['openai', 'gemini', 'claude', 'local'] as const

/** Known providers that support embeddings. */
export const EMBEDDING_PROVIDERS = ['openai', 'gemini', 'local'] as const

export type ProviderConnectionType = 'apiKey' | 'baseUrl'

export const PROVIDER_METADATA = {
  openai: {
    label: 'OpenAI',
    connectionType: 'apiKey',
    supports: { llm: true, embedding: true },
  },
  gemini: {
    label: 'Google Gemini',
    connectionType: 'apiKey',
    supports: { llm: true, embedding: true },
  },
  claude: {
    label: 'Anthropic Claude',
    connectionType: 'apiKey',
    supports: { llm: true, embedding: false },
  },
  local: {
    label: 'Local Provider',
    connectionType: 'baseUrl',
    supports: { llm: true, embedding: true },
  },
} as const

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

export const ENV_BASE_URLS: Record<string, string> = {
  local: env.LOCAL_PROVIDER_BASE_URL,
}
