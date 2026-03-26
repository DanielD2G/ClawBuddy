import { OpenAICompatibleLLMProvider } from './openai-compatible.js'

/** Models that only accept max_completion_tokens (not max_tokens). */
function usesMaxCompletionTokens(model: string): boolean {
  return /^(o[134]|gpt-4\.1|gpt-4o|gpt-5)/.test(model)
}

/**
 * Reasoning models that do not support sampling parameters (temperature, top_p, etc.).
 * - o-series (o1, o3, o4) reject temperature entirely.
 * - gpt-5 reasoning variants (gpt-5, gpt-5-mini, gpt-5-nano) only accept the default (1).
 * - gpt-5-chat-* variants DO support temperature, excluded via negative lookahead.
 * See: https://community.openai.com/t/temperature-in-gpt-5-models/1337133
 */
function isFixedTemperatureModel(model: string): boolean {
  return /^(o[134]|gpt-5(?!-chat))/.test(model)
}

export class OpenAILLMProvider extends OpenAICompatibleLLMProvider {
  constructor(model = 'gpt-5.4', apiKey?: string) {
    super({
      providerId: 'openai',
      model,
      apiKey,
      useMaxCompletionTokens: usesMaxCompletionTokens,
      isFixedTemperature: isFixedTemperatureModel,
    })
  }
}
