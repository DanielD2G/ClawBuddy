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
}
