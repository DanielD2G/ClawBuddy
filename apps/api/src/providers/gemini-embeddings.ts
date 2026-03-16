import { GoogleGenerativeAI } from '@google/generative-ai'
import type { EmbeddingProvider } from './embeddings.interface.js'

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  private client: GoogleGenerativeAI
  private model: string

  constructor(model = 'gemini-embedding-001', apiKey?: string) {
    this.client = new GoogleGenerativeAI(apiKey ?? '')
    this.model = model
  }

  async embed(text: string): Promise<number[]> {
    const model = this.client.getGenerativeModel({ model: this.model })
    const result = await model.embedContent(text)
    return result.embedding.values
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const model = this.client.getGenerativeModel({ model: this.model })
    const result = await model.batchEmbedContents({
      requests: texts.map((text) => ({ content: { role: 'user', parts: [{ text }] } })),
    })
    return result.embeddings.map((e) => e.values)
  }
}
