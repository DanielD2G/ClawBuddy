import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),
  QDRANT_URL: z.string(),
  MINIO_ENDPOINT: z.string(),
  MINIO_ACCESS_KEY: z.string(),
  MINIO_SECRET_KEY: z.string(),
  MINIO_BUCKET: z.string(),

  // Encryption secret for API key storage
  ENCRYPTION_SECRET: z.string().min(16, 'ENCRYPTION_SECRET must be at least 16 characters'),

  // App URL (used for CORS and OAuth redirects)
  APP_URL: z.string().default('http://localhost:5173'),

  // AI providers
  AI_PROVIDER: z.enum(['openai', 'gemini', 'claude', 'local']).default('openai'),
  EMBEDDING_PROVIDER: z.enum(['openai', 'gemini']).default('openai'),
  OPENAI_API_KEY: z.string().default(''),
  GEMINI_API_KEY: z.string().default(''),
  ANTHROPIC_API_KEY: z.string().default(''),

  // Google OAuth (for Google Workspace integration)
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),

  // Local models (OpenAI-compatible server: LM Studio, vLLM, Ollama, etc.)
  LOCAL_MODEL_BASE_URL: z.string().default(''),

  // Browser grid
  BROWSER_GRID_URL: z.string().default(''),
  BROWSER_GRID_API_KEY: z.string().default(''),

  // Debug flags
  DEBUG_AGENT: z.string().default(''),
})

export const env = envSchema.parse(process.env)

// Warn at startup if no API keys are configured at all
const hasAnyKey = !!(env.OPENAI_API_KEY || env.GEMINI_API_KEY || env.ANTHROPIC_API_KEY)
if (!hasAnyKey) {
  console.warn(
    '⚠️  No AI provider API keys configured. Set at least one of: OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY',
  )
}
