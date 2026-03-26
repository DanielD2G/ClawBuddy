export const EMBEDDING_DIMENSIONS: Record<string, number> = {
  // OpenAI
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  // Gemini
  'gemini-embedding-001': 768,
  'gemini-embedding-2-preview': 3072,
}

// ── Always-on capabilities ──────────────────────
// These capabilities are always enabled for every workspace (cannot be disabled).
// However, only tool-discovery is loaded into the LLM prompt natively —
// the agent must discover all other tools dynamically via discover_tools.
export const ALWAYS_ON_CAPABILITY_SLUGS = [
  'document-search',
  'agent-memory',
  'cron-management',
  'bash',
  'python',
  'web-fetch',
  'read-file',
  'sub-agent-delegation',
  'tool-discovery',
]

export const CHUNK_SIZE = 512
export const CHUNK_OVERLAP = 50
export const QDRANT_COLLECTION_NAME = 'clawbuddy_chunks'
