import { Hono } from 'hono'
import { Prisma } from '@prisma/client'
import { settingsService } from '../services/settings.service.js'
import { discoverLLMModels, invalidateModelCache } from '../services/model-discovery.service.js'
import { buildProviderState } from '../services/provider-state.service.js'
import { handleProviderConnectionTest } from './provider-connection-test.js'
import { prisma } from '../lib/prisma.js'

const app = new Hono()

type TokenUsageByProviderRow = {
  provider: string
  _sum: {
    inputTokens: number | null
    outputTokens: number | null
    totalTokens: number | null
  }
}

type TokenUsageByModelRow = {
  model: string
  _sum: {
    inputTokens: number | null
    outputTokens: number | null
    totalTokens: number | null
  }
}

type TokenUsageByDayRow = {
  date: string
  _sum: {
    inputTokens: number | null
    outputTokens: number | null
    totalTokens: number | null
  }
}

app.get('/global-settings/providers', async (c) => {
  return c.json({
    success: true,
    data: await buildProviderState(),
  })
})

app.put('/global-settings/provider-connections/:provider', async (c) => {
  const { provider } = c.req.param()
  const { value } = await c.req.json()
  if (!value || typeof value !== 'string') {
    return c.json({ success: false, error: 'value is required' }, 400)
  }

  await settingsService.setProviderConnection(provider, value)
  invalidateModelCache(provider)

  return c.json({
    success: true,
    data: {
      connections: await settingsService.getProviderConnections(),
      providers: await buildProviderState(),
    },
  })
})

app.delete('/global-settings/provider-connections/:provider', async (c) => {
  const { provider } = c.req.param()
  await settingsService.removeProviderConnection(provider)
  invalidateModelCache(provider)

  return c.json({
    success: true,
    data: {
      connections: await settingsService.getProviderConnections(),
      providers: await buildProviderState(),
    },
  })
})

app.post('/global-settings/provider-connections/:provider/test', handleProviderConnectionTest)

app.get('/global-settings/models', async (c) => {
  const [
    provider,
    primary,
    medium,
    light,
    explore,
    execute,
    title,
    compact,
    embeddingModel,
    advancedModelConfig,
    contextLimitTokens,
    maxAgentIterations,
    subAgentExploreMaxIterations,
    subAgentAnalyzeMaxIterations,
    subAgentExecuteMaxIterations,
    available,
    roleProviders,
    timezone,
  ] = await Promise.all([
    settingsService.getAIProvider(),
    settingsService.getAIModel(),
    settingsService.getMediumModel(),
    settingsService.getLightModel(),
    settingsService.getExploreModel(),
    settingsService.getExecuteModel(),
    settingsService.getTitleModel(),
    settingsService.getCompactModel(),
    settingsService.getEmbeddingModel(),
    settingsService.getAdvancedModelConfig(),
    settingsService.getContextLimitTokens(),
    settingsService.getMaxAgentIterations(),
    settingsService.getSubAgentExploreMaxIterations(),
    settingsService.getSubAgentAnalyzeMaxIterations(),
    settingsService.getSubAgentExecuteMaxIterations(),
    settingsService.getAvailableProviders(),
    settingsService.getResolvedRoleProviders(),
    settingsService.getTimezone(),
  ])

  const catalogEntries = await Promise.all(
    available.llm.map(async (p) => [p, await discoverLLMModels(p)] as const),
  )
  const catalogs = Object.fromEntries(catalogEntries) as Record<string, string[]>

  return c.json({
    success: true,
    data: {
      provider,
      models: { primary, medium, light, explore, execute, title, compact },
      roleProviders,
      embeddingModel,
      advancedModelConfig,
      contextLimitTokens,
      maxAgentIterations,
      subAgentExploreMaxIterations,
      subAgentAnalyzeMaxIterations,
      subAgentExecuteMaxIterations,
      availableProviders: available.llm,
      catalogs,
      timezone,
    },
  })
})

app.patch('/global-settings/models', async (c) => {
  const body = await c.req.json()
  const updateData: Record<string, unknown> = {}

  if (body.provider !== undefined) updateData.aiProvider = body.provider
  if (body.primary !== undefined) updateData.aiModel = body.primary
  if (body.medium !== undefined) updateData.mediumModel = body.medium
  if (body.light !== undefined) updateData.lightModel = body.light
  if (body.explore !== undefined) updateData.exploreModel = body.explore
  if (body.execute !== undefined) updateData.executeModel = body.execute
  if (body.title !== undefined) updateData.titleModel = body.title
  if (body.compact !== undefined) updateData.compactModel = body.compact
  if (body.roleProviders !== undefined) updateData.roleProviders = body.roleProviders
  if (body.advancedModelConfig !== undefined) {
    updateData.advancedModelConfig = body.advancedModelConfig
  }
  if (body.contextLimitTokens !== undefined) updateData.contextLimitTokens = body.contextLimitTokens
  if (body.maxAgentIterations !== undefined) updateData.maxAgentIterations = body.maxAgentIterations
  if (body.subAgentExploreMaxIterations !== undefined) {
    updateData.subAgentExploreMaxIterations = body.subAgentExploreMaxIterations
  }
  if (body.subAgentAnalyzeMaxIterations !== undefined) {
    updateData.subAgentAnalyzeMaxIterations = body.subAgentAnalyzeMaxIterations
  }
  if (body.subAgentExecuteMaxIterations !== undefined) {
    updateData.subAgentExecuteMaxIterations = body.subAgentExecuteMaxIterations
  }
  if (body.timezone !== undefined) updateData.timezone = body.timezone

  await settingsService.update(updateData as Parameters<typeof settingsService.update>[0])
  return c.json({ success: true })
})

app.get('/global-settings/token-usage', async (c) => {
  const totals = await prisma.tokenUsage.aggregate({
    _sum: {
      inputTokens: true,
      outputTokens: true,
      totalTokens: true,
    },
    _count: true,
  })

  const byProviderResult = await prisma.tokenUsage.groupBy({
    by: ['provider'],
    _sum: {
      inputTokens: true,
      outputTokens: true,
      totalTokens: true,
    },
  })
  const byProvider = byProviderResult as TokenUsageByProviderRow[]

  const byModelResult = await prisma.tokenUsage.groupBy({
    by: ['model'],
    _sum: {
      inputTokens: true,
      outputTokens: true,
      totalTokens: true,
    },
  })
  const byModel = byModelResult as TokenUsageByModelRow[]

  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
  const dailyStr = sevenDaysAgo.toISOString().slice(0, 10)

  const dailyResult = await prisma.tokenUsage.groupBy({
    by: ['date'],
    where: { date: { gte: dailyStr } },
    _sum: {
      inputTokens: true,
      outputTokens: true,
      totalTokens: true,
    },
    orderBy: { date: 'asc' },
  })
  const daily = dailyResult as TokenUsageByDayRow[]

  return c.json({
    success: true,
    data: {
      totals: {
        inputTokens: totals._sum.inputTokens ?? 0,
        outputTokens: totals._sum.outputTokens ?? 0,
        totalTokens: totals._sum.totalTokens ?? 0,
        requests: totals._count,
      },
      byProvider: byProvider.map((p) => ({
        provider: p.provider,
        inputTokens: p._sum.inputTokens ?? 0,
        outputTokens: p._sum.outputTokens ?? 0,
        totalTokens: p._sum.totalTokens ?? 0,
      })),
      byModel: byModel.map((m) => ({
        model: m.model,
        inputTokens: m._sum.inputTokens ?? 0,
        outputTokens: m._sum.outputTokens ?? 0,
        totalTokens: m._sum.totalTokens ?? 0,
      })),
      daily: daily.map((d) => ({
        date: d.date,
        inputTokens: d._sum.inputTokens ?? 0,
        outputTokens: d._sum.outputTokens ?? 0,
        totalTokens: d._sum.totalTokens ?? 0,
      })),
    },
  })
})

app.delete('/global-settings/token-usage', async (c) => {
  await prisma.tokenUsage.deleteMany()
  return c.json({ success: true })
})

app.get('/global-settings/google-oauth', (c) => {
  return c.json({
    success: true,
    data: { configured: settingsService.isGoogleOAuthConfigured() },
  })
})

app.post('/global-settings/google-oauth/test', async (c) => {
  const creds = await settingsService.getGoogleCredentials()
  if (!creds) {
    return c.json({ success: false, error: 'Google OAuth credentials not configured' }, 400)
  }

  const { decryptConfigFields } = await import('../services/config-validation.service.js')
  const clientId = creds.clientId
  const clientSecret = creds.clientSecret

  const result: {
    valid: boolean
    message?: string
    apis?: { gmail: boolean; calendar: boolean; drive: boolean }
    connectedEmail?: string | null
  } = { valid: false }

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: 'test_dummy_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: 'http://localhost',
        grant_type: 'authorization_code',
      }),
    })
    const data = (await res.json()) as { error?: string; error_description?: string }

    if (data.error === 'invalid_client') {
      result.message = 'Invalid Client ID or Client Secret'
      return c.json({ success: true, data: result })
    }
    if (data.error !== 'invalid_grant' && data.error !== 'redirect_uri_mismatch') {
      result.message = data.error_description || data.error || 'Unknown error'
      return c.json({ success: true, data: result })
    }
  } catch {
    result.message = 'Could not reach Google servers'
    return c.json({ success: true, data: result })
  }

  result.valid = true

  const gwsCap = await prisma.capability.findUnique({ where: { slug: 'google-workspace' } })
  if (!gwsCap) return c.json({ success: true, data: result })

  const connectedWc = await prisma.workspaceCapability.findFirst({
    where: { capabilityId: gwsCap.id, enabled: true, config: { not: Prisma.AnyNull } },
  })
  if (!connectedWc?.config) return c.json({ success: true, data: result })

  const schema = gwsCap.configSchema as
    | import('../capabilities/types.js').ConfigFieldDefinition[]
    | null
  const decrypted = decryptConfigFields(schema ?? [], connectedWc.config as Record<string, unknown>)

  if (!decrypted.gwsCredentialsFile) return c.json({ success: true, data: result })

  result.connectedEmail = (decrypted.email as string) || null

  let accessToken: string
  try {
    const credentials = JSON.parse(decrypted.gwsCredentialsFile as string) as {
      refresh_token: string
    }
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: credentials.refresh_token,
        grant_type: 'refresh_token',
      }),
    })
    const tokenData = (await tokenRes.json()) as {
      access_token?: string
      error?: string
      error_description?: string
    }
    if (!tokenData.access_token) {
      result.message = `Token refresh failed: ${tokenData.error_description || tokenData.error}`
      result.valid = false
      return c.json({ success: true, data: result })
    }
    accessToken = tokenData.access_token
  } catch {
    return c.json({ success: true, data: result })
  }

  const apiTests = {
    gmail: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    calendar: 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1',
    drive: 'https://www.googleapis.com/drive/v3/about?fields=user',
  } as const

  const entries = await Promise.all(
    Object.entries(apiTests).map(async ([name, url]) => {
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        return [name, res.ok] as const
      } catch {
        return [name, false] as const
      }
    }),
  )

  result.apis = Object.fromEntries(entries) as {
    gmail: boolean
    calendar: boolean
    drive: boolean
  }

  return c.json({ success: true, data: result })
})

export default app
