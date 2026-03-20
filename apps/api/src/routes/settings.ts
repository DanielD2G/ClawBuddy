import { Hono } from 'hono'
import { settingsService } from '../services/settings.service.js'
import { discoverLLMModels } from '../services/model-discovery.service.js'
import { prisma } from '../lib/prisma.js'
import { buildProviderState } from '../services/provider-state.service.js'

const app = new Hono()

app.get('/settings/providers', async (c) => {
  return c.json({
    success: true,
    data: await buildProviderState(),
  })
})

// Model configuration
app.get('/settings/models', async (c) => {
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

  // Build per-provider catalogs for all available LLM providers
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

app.patch('/settings/models', async (c) => {
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
  if (body.advancedModelConfig !== undefined)
    updateData.advancedModelConfig = body.advancedModelConfig
  if (body.contextLimitTokens !== undefined) updateData.contextLimitTokens = body.contextLimitTokens
  if (body.maxAgentIterations !== undefined) updateData.maxAgentIterations = body.maxAgentIterations
  if (body.subAgentExploreMaxIterations !== undefined)
    updateData.subAgentExploreMaxIterations = body.subAgentExploreMaxIterations
  if (body.subAgentAnalyzeMaxIterations !== undefined)
    updateData.subAgentAnalyzeMaxIterations = body.subAgentAnalyzeMaxIterations
  if (body.subAgentExecuteMaxIterations !== undefined)
    updateData.subAgentExecuteMaxIterations = body.subAgentExecuteMaxIterations
  if (body.timezone !== undefined) updateData.timezone = body.timezone

  await settingsService.update(updateData as Parameters<typeof settingsService.update>[0])
  return c.json({ success: true })
})

// Token usage stats
app.get('/settings/token-usage', async (c) => {
  // Totals
  const totals = await prisma.tokenUsage.aggregate({
    _sum: {
      inputTokens: true,
      outputTokens: true,
      totalTokens: true,
    },
    _count: true,
  })

  // Per-provider totals
  const byProvider = await prisma.tokenUsage.groupBy({
    by: ['provider'],
    _sum: {
      inputTokens: true,
      outputTokens: true,
      totalTokens: true,
    },
  })

  // Per-model totals
  const byModel = await prisma.tokenUsage.groupBy({
    by: ['model'],
    _sum: {
      inputTokens: true,
      outputTokens: true,
      totalTokens: true,
    },
  })

  // Last 7 days daily breakdown
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
  const dailyStr = sevenDaysAgo.toISOString().slice(0, 10)

  const daily = await prisma.tokenUsage.groupBy({
    by: ['date'],
    where: { date: { gte: dailyStr } },
    _sum: {
      inputTokens: true,
      outputTokens: true,
      totalTokens: true,
    },
    orderBy: { date: 'asc' },
  })

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

// Reset token usage
app.delete('/settings/token-usage', async (c) => {
  await prisma.tokenUsage.deleteMany()
  return c.json({ success: true })
})

export default app
