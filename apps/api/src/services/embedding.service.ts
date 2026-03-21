import { createEmbeddingProvider } from '../providers/index.js'

let dimensionsCache: number | null = null

export const embeddingService = {
  async embed(text: string): Promise<number[]> {
    const provider = await createEmbeddingProvider()
    return provider.embed(text)
  },

  async embedBatch(texts: string[]): Promise<number[][]> {
    const provider = await createEmbeddingProvider()
    return provider.embedBatch(texts)
  },

  async getEmbeddingDimensions(): Promise<number> {
    if (dimensionsCache != null) return dimensionsCache
    const vector = await this.embed('dimension probe')
    dimensionsCache = vector.length
    return vector.length
  },
}
