import { Hono } from 'hono'
import {
  createWorkspaceSchema,
  updateWorkspaceSchema,
  workspaceExportSchema,
} from '@clawbuddy/shared'
import type { WorkspaceExport } from '@clawbuddy/shared'
import { workspaceService } from '../services/workspace.service.js'
import { capabilityService } from '../services/capability.service.js'
import { sandboxService } from '../services/sandbox.service.js'
import { settingsService } from '../services/settings.service.js'
import { channelService } from '../services/channel.service.js'
import { prisma } from '../lib/prisma.js'
import { decrypt } from '../services/crypto.service.js'
import { decryptConfigFields } from '../services/config-validation.service.js'
import { validateBody } from '../lib/validate.js'

const app = new Hono()

app.get('/', async (c) => {
  const workspaces = await workspaceService.list()
  return c.json({ success: true, data: workspaces })
})

app.post('/', async (c) => {
  const body = await c.req.json()
  const parsed = validateBody(createWorkspaceSchema, body)
  const workspace = await workspaceService.create(parsed)
  return c.json({ success: true, data: workspace }, 201)
})

// ── Workspace Import (must be before /:id to avoid param match) ──

app.post('/import', async (c) => {
  const body = await c.req.json()
  const parsed = validateBody(workspaceExportSchema, body)

  const skippedCapabilities: string[] = []
  const warnings: string[] = []

  // Create workspace
  const workspace = await workspaceService.create({
    name: `${parsed.workspace.name} (imported)`,
    description: parsed.workspace.description ?? undefined,
    color: parsed.workspace.color ?? undefined,
    settings: parsed.workspace.settings ?? undefined,
  })

  // Apply permissions and autoExecute
  await workspaceService.update(workspace.id, {
    permissions: parsed.workspace.permissions ?? undefined,
    autoExecute: parsed.workspace.autoExecute,
  })

  // Enable capabilities
  for (const cap of parsed.capabilities) {
    if (!cap.enabled) continue
    try {
      await capabilityService.enableCapability(
        workspace.id,
        cap.slug,
        cap.config as Record<string, unknown> | undefined,
      )
    } catch {
      skippedCapabilities.push(cap.slug)
    }
  }

  // Create channels (disabled by default)
  for (const ch of parsed.channels) {
    try {
      const config = ch.config as { botToken: string; [key: string]: unknown }
      if (!config.botToken) {
        warnings.push(`Channel "${ch.name}" skipped — no bot token`)
        continue
      }
      await channelService.create({
        workspaceId: workspace.id,
        type: ch.type,
        name: ch.name,
        config: { botToken: config.botToken },
      })
      warnings.push(`Channel "${ch.name}" imported as disabled — enable it manually after testing`)
    } catch {
      warnings.push(`Failed to import channel "${ch.name}"`)
    }
  }

  // Ensure always-on capabilities
  await capabilityService.ensureAlwaysOnCapabilities()

  return c.json({
    success: true,
    data: {
      workspace,
      skippedCapabilities,
      warnings,
      modelConfig: parsed.modelConfig,
    },
  })
})

app.get('/:id', async (c) => {
  const { id } = c.req.param()
  const workspace = await workspaceService.findById(id)
  if (!workspace) {
    return c.json({ success: false, error: 'Workspace not found' }, 404)
  }
  return c.json({ success: true, data: workspace })
})

app.patch('/:id', async (c) => {
  const { id } = c.req.param()
  const body = await c.req.json()
  const parsed = validateBody(updateWorkspaceSchema, body)
  const workspace = await workspaceService.update(id, parsed)
  return c.json({ success: true, data: workspace })
})

app.delete('/:id', async (c) => {
  const { id } = c.req.param()
  try {
    await sandboxService.stopWorkspaceContainer(id)
  } catch (err) {
    console.warn(`[Workspaces] Failed to stop container for workspace ${id}:`, err)
  }
  await workspaceService.delete(id)
  return c.json({ success: true, data: { id } })
})

// ── Workspace Export ──────────────────────────────────────

app.get('/:id/export', async (c) => {
  const { id } = c.req.param()
  const workspace = await workspaceService.findById(id)
  if (!workspace) {
    return c.json({ success: false, error: 'Workspace not found' }, 404)
  }

  // Enabled capabilities with decrypted configs
  const enabledCaps = await capabilityService.getEnabledCapabilitiesForWorkspace(id)
  const capabilities = enabledCaps.map((cap) => {
    const schema = cap.configSchema as
      | import('../capabilities/types.js').ConfigFieldDefinition[]
      | null
    const rawConfig = cap.config as Record<string, unknown> | null
    const config = schema?.length && rawConfig ? decryptConfigFields(schema, rawConfig) : rawConfig
    return { slug: cap.slug, enabled: true, config }
  })

  // Channels with decrypted tokens
  const rawChannels = await prisma.channel.findMany({ where: { workspaceId: id } })
  const channels = rawChannels.map((ch) => {
    const config = ch.config as Record<string, string>
    let decryptedConfig: Record<string, unknown> = { ...config }
    if (config.botToken) {
      try {
        decryptedConfig.botToken = decrypt(config.botToken)
      } catch {
        /* may not be encrypted */
      }
    }
    return { type: ch.type, name: ch.name, enabled: ch.enabled, config: decryptedConfig }
  })

  // Global model config
  const settings = await settingsService.get()
  const modelConfig = {
    aiProvider: settings.aiProvider,
    aiModel: settings.aiModel,
    mediumModel: settings.mediumModel,
    lightModel: settings.lightModel,
    exploreModel: settings.exploreModel,
    executeModel: settings.executeModel,
    titleModel: settings.titleModel,
    compactModel: settings.compactModel,
    advancedModelConfig: settings.advancedModelConfig,
    embeddingProvider: settings.embeddingProvider,
    embeddingModel: settings.embeddingModel,
    contextLimitTokens: settings.contextLimitTokens,
    maxAgentIterations: settings.maxAgentIterations,
    subAgentExploreMaxIterations: settings.subAgentExploreMaxIterations,
    subAgentAnalyzeMaxIterations: settings.subAgentAnalyzeMaxIterations,
    subAgentExecuteMaxIterations: settings.subAgentExecuteMaxIterations,
    timezone: settings.timezone,
  }

  // Token usage summary
  const usage = await prisma.tokenUsage.groupBy({
    by: ['provider', 'model'],
    _sum: { inputTokens: true, outputTokens: true },
  })
  const totals = await prisma.tokenUsage.aggregate({
    _sum: { inputTokens: true, outputTokens: true },
  })
  const tokenUsage = {
    totalInputTokens: totals._sum.inputTokens ?? 0,
    totalOutputTokens: totals._sum.outputTokens ?? 0,
    byModel: usage.map((u) => ({
      provider: u.provider,
      model: u.model,
      inputTokens: u._sum.inputTokens ?? 0,
      outputTokens: u._sum.outputTokens ?? 0,
    })),
  }

  const exportData: WorkspaceExport = {
    version: 1,
    exportedAt: new Date().toISOString(),
    workspace: {
      name: workspace.name,
      description: workspace.description,
      color: workspace.color,
      autoExecute: workspace.autoExecute,
      settings: workspace.settings as Record<string, unknown> | null,
      permissions: workspace.permissions as { allow: string[] } | null,
    },
    capabilities,
    channels,
    modelConfig,
    tokenUsage,
  }

  const filename = `workspace-${workspace.name.replace(/[^a-zA-Z0-9-_]/g, '_')}-export.json`
  c.header('Content-Disposition', `attachment; filename="${filename}"`)
  c.header('Content-Type', 'application/json')
  return c.json({ success: true, data: exportData })
})

// ── Workspace Capability Overrides ─────────────────────────

app.get('/:id/capabilities', async (c) => {
  const { id } = c.req.param()
  const capabilities = await capabilityService.getWorkspaceCapabilitySettings(id)
  return c.json({ success: true, data: capabilities })
})

app.put('/:id/capabilities/:capabilitySlug', async (c) => {
  const { id, capabilitySlug } = c.req.param()
  const body = await c.req.json()
  if (body.enabled) {
    await capabilityService.enableCapability(id, capabilitySlug, body.config)
  } else {
    await capabilityService.disableCapabilityBySlug(id, capabilitySlug)
  }
  return c.json({ success: true })
})

app.delete('/:id/capabilities/:capabilityId', async (c) => {
  const { id, capabilityId } = c.req.param()
  try {
    await capabilityService.removeCapabilityOverride(id, capabilityId)
    return c.json({ success: true })
  } catch {
    return c.json({ success: false, error: 'Override not found' }, 404)
  }
})

// ── Workspace Container Management ─────────────────────────

app.get('/:id/container/status', async (c) => {
  const { id } = c.req.param()
  const status = await sandboxService.getWorkspaceContainerStatus(id)
  return c.json({ success: true, data: status })
})

app.post('/:id/container/start', async (c) => {
  const { id } = c.req.param()
  const containerId = await sandboxService.startWorkspaceContainerWithCapabilities(id)
  return c.json({ success: true, data: { containerId, status: 'running' } })
})

app.post('/:id/container/stop', async (c) => {
  const { id } = c.req.param()
  await sandboxService.stopWorkspaceContainer(id)
  return c.json({ success: true, data: { status: 'stopped' } })
})

export default app
