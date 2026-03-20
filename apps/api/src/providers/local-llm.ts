import { OpenAICompatibleLLMProvider } from './openai-compatible.js'

export class LocalLLMProvider extends OpenAICompatibleLLMProvider {
  constructor(model: string, baseURL: string) {
    super({
      providerId: 'local',
      model,
      baseURL,
    })
  }
}
