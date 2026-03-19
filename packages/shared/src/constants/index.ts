export const EMBEDDING_DIMENSIONS: Record<string, number> = {
  // OpenAI
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  // Gemini
  'gemini-embedding-001': 768,
  'gemini-embedding-2-preview': 3072,
}

export const CHUNK_SIZE = 512
export const CHUNK_OVERLAP = 50
export const QDRANT_COLLECTION_NAME = 'clawbuddy_chunks'
