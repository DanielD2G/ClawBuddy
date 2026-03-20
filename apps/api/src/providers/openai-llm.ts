import { OpenAICompatibleLLMProvider } from './openai-compatible.js'

/** Models that only accept max_completion_tokens (not max_tokens). */
function usesMaxCompletionTokens(model: string): boolean {
  return /^(o[134]|gpt-4\.1|gpt-4o|gpt-5)/.test(model)
}

export class OpenAILLMProvider extends OpenAICompatibleLLMProvider {
  constructor(model = 'gpt-5.4', apiKey?: string) {
    super({
      providerId: 'openai',
      model,
      apiKey,
      useMaxCompletionTokens: usesMaxCompletionTokens,
    })
  }
}
