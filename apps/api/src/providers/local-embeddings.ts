import { OpenAICompatibleEmbeddingProvider } from './openai-compatible.js'

export class LocalEmbeddingProvider extends OpenAICompatibleEmbeddingProvider {
  constructor(model: string, baseURL: string) {
    super({
      model,
      baseURL,
    })
  }
}
