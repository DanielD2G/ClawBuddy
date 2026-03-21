import { OpenAICompatibleEmbeddingProvider } from './openai-compatible.js'

export class OpenAIEmbeddingProvider extends OpenAICompatibleEmbeddingProvider {
  constructor(model = 'text-embedding-3-small', apiKey?: string) {
    super({
      model,
      apiKey,
    })
  }
}
