import { qdrant } from '../lib/qdrant.js'
import { QDRANT_COLLECTION_NAME } from '@agentbuddy/shared'
import type { Schemas } from '@qdrant/js-client-rest'

export const searchService = {
  async search(
    queryVector: number[],
    options?: { limit?: number; workspaceId?: string; documentIds?: string[] }
  ) {
    const must: Schemas['Condition'][] = []
    if (options?.workspaceId) {
      must.push({ key: 'workspaceId', match: { value: options.workspaceId } })
    }
    if (options?.documentIds?.length) {
      // OR across multiple document IDs
      must.push({
        should: options.documentIds.map((id) => ({
          key: 'documentId',
          match: { value: id },
        })),
      })
    }
    const filter = must.length ? { must } : undefined

    const results = await qdrant.search(QDRANT_COLLECTION_NAME, {
      vector: queryVector,
      limit: options?.limit ?? 10,
      filter,
      with_payload: true,
    })
    return results
  },

  async upsert(id: string, vector: number[], payload: Record<string, unknown>) {
    await qdrant.upsert(QDRANT_COLLECTION_NAME, {
      points: [{ id, vector, payload }],
    })
  },

  async ensureCollection(dimensions: number) {
    const collections = await qdrant.getCollections()
    const exists = collections.collections.some(
      (c) => c.name === QDRANT_COLLECTION_NAME
    )

    if (exists) {
      const info = await qdrant.getCollection(QDRANT_COLLECTION_NAME)
      const currentSize = (info.config.params.vectors as { size: number }).size
      if (currentSize !== dimensions) {
        console.warn(
          `[Search] Collection dimension mismatch (${currentSize} vs ${dimensions}). Recreating collection.`
        )
        await qdrant.deleteCollection(QDRANT_COLLECTION_NAME)
        await qdrant.createCollection(QDRANT_COLLECTION_NAME, {
          vectors: { size: dimensions, distance: 'Cosine' },
        })
      }
    } else {
      await qdrant.createCollection(QDRANT_COLLECTION_NAME, {
        vectors: { size: dimensions, distance: 'Cosine' },
      })
    }
  },
}
