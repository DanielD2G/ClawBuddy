import { createEmbeddingProvider } from '../providers/index.js'

export const embeddingService = {
  async embed(text: string): Promise<number[]> {
    const provider = await createEmbeddingProvider()
    return provider.embed(text)
  },

  async embedBatch(texts: string[]): Promise<number[][]> {
    const provider = await createEmbeddingProvider()
    return provider.embedBatch(texts)
  },

  _dimensionsCache: null as number | null,

  async getEmbeddingDimensions(): Promise<number> {
    if (this._dimensionsCache != null) return this._dimensionsCache
    const vector = await this.embed('dimension probe')
    this._dimensionsCache = vector.length
    return vector.length
  },
}
