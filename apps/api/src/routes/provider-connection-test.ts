import type { Context } from 'hono'
import { settingsService } from '../services/settings.service.js'
import { testProviderConnection } from '../services/model-discovery.service.js'

export async function handleProviderConnectionTest(c: Context) {
  const { provider } = c.req.param()
  const body = await c.req.json().catch(() => ({}))
  const requestValue = typeof body.value === 'string' ? body.value : null
  const configuredValue =
    requestValue ?? (await settingsService.getProviderConnectionValue(provider))

  if (!configuredValue?.trim()) {
    return c.json(
      {
        success: true,
        data: {
          valid: false,
          reachable: false,
          llmModels: [],
          embeddingModels: [],
          message: 'No connection configured',
        },
      },
      200,
    )
  }

  return c.json({
    success: true,
    data: await testProviderConnection(provider, configuredValue),
  })
}
