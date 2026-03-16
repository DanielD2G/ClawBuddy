import OpenAI from 'openai'
import type { EmbeddingProvider } from './embeddings.interface.js'

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI
  private model: string

  constructor(model = 'text-embedding-3-small', apiKey?: string) {
    this.client = new OpenAI({ apiKey })
    this.model = model
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
    })
    return response.data[0].embedding
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    })
    return response.data.map((d) => d.embedding)
  }
}
