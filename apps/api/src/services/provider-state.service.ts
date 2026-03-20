import { settingsService } from './settings.service.js'
import { buildModelCatalogs } from './model-discovery.service.js'
import { buildResolvedRoleProviders } from '../lib/llm-resolver.js'

export async function buildProviderState() {
  const settings = await settingsService.get()
  const available = await settingsService.getAvailableProviders()
  const models = await buildModelCatalogs(available)

  return {
    metadata: settingsService.getProviderMetadata(),
    connections: await settingsService.getProviderConnections(),
    active: {
      llm: settings.aiProvider,
      llmModel: settings.aiModel,
      mediumModel: settings.mediumModel,
      lightModel: settings.lightModel,
      exploreModel: settings.exploreModel,
      executeModel: settings.executeModel,
      titleModel: settings.titleModel,
      compactModel: settings.compactModel,
      advancedModelConfig: settings.advancedModelConfig,
      roleProviders: buildResolvedRoleProviders(settings),
      embedding: settings.embeddingProvider,
      embeddingModel: settings.embeddingModel,
      localBaseUrl: settings.localBaseUrl,
    },
    available,
    models,
  }
}
