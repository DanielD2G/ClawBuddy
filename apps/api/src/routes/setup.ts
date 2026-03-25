import { Hono } from 'hono'
import type { Context } from 'hono'
import { settingsService } from '../services/settings.service.js'
import { invalidateModelCache } from '../services/model-discovery.service.js'
import { searchService } from '../services/search.service.js'
import { capabilityService } from '../services/capability.service.js'
import { toolDiscoveryService } from '../services/tool-discovery.service.js'
import { prisma } from '../lib/prisma.js'
import { workspaceExportSchema } from '@clawbuddy/shared'
import { imageBuilderService } from '../services/image-builder.service.js'
import { qdrant } from '../lib/qdrant.js'
import { s3 } from '../lib/s3.js'
import { embeddingService } from '../services/embedding.service.js'
import { env } from '../env.js'
import { ListBucketsCommand } from '@aws-sdk/client-s3'
import { Prisma } from '@prisma/client'
import { validateBody } from '../lib/validate.js'
import Docker from 'dockerode'
import { buildProviderState } from '../services/provider-state.service.js'
import { handleProviderConnectionTest } from './provider-connection-test.js'
import { SANDBOX_BASE_IMAGE } from '../constants.js'

const app = new Hono()

// Guard: reject if onboarding already done
async function requireSetupIncomplete(c: Context): Promise<Response | null> {
  const settings = await settingsService.get()
  if (settings.onboardingComplete) {
    return c.json({ success: false, error: 'Setup already completed' }, 400)
  }
  return null
}

// All endpoints are public (no auth middleware)

app.get('/status', async (c) => {
  const settings = await settingsService.get()
  return c.json({
    success: true,
    data: { onboardingComplete: settings.onboardingComplete },
  })
})

app.get('/settings', async (c) => {
  const blocked = await requireSetupIncomplete(c)
  if (blocked) return blocked

  return c.json({
    success: true,
    data: {
      providers: await buildProviderState(),
      browserGridFromEnv: !!process.env.BROWSER_GRID_URL,
    },
  })
})

app.patch('/settings', async (c) => {
  const blocked = await requireSetupIncomplete(c)
  if (blocked) return blocked

  const body = await c.req.json()
  const settings = await settingsService.update({
    aiProvider: body.llm,
    aiModel: body.llmModel,
    mediumModel: body.mediumModel,
    lightModel: body.lightModel,
    embeddingProvider: body.embedding,
    embeddingModel: body.embeddingModel,
    advancedModelConfig: body.advancedModelConfig,
    exploreModel: body.exploreModel,
    executeModel: body.executeModel,
    titleModel: body.titleModel,
    compactModel: body.compactModel,
    roleProviders: body.roleProviders,
  })
  return c.json({
    success: true,
    data: {
      active: {
        llm: settings.aiProvider,
        llmModel: settings.aiModel,
        mediumModel: settings.mediumModel,
        lightModel: settings.lightModel,
        exploreModel: settings.exploreModel,
        executeModel: settings.executeModel,
        titleModel: settings.titleModel,
        compactModel: settings.compactModel,
        roleProviders: await settingsService.getResolvedRoleProviders(),
        embedding: settings.embeddingProvider,
        embeddingModel: settings.embeddingModel,
      },
    },
  })
})

app.get('/capabilities', async (c) => {
  const capabilities = await prisma.capability.findMany({
    select: {
      slug: true,
      name: true,
      description: true,
      category: true,
      configSchema: true,
    },
    orderBy: { slug: 'asc' },
  })
  return c.json({ success: true, data: capabilities })
})

app.put('/provider-connections/:provider', async (c) => {
  const blocked = await requireSetupIncomplete(c)
  if (blocked) return blocked

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

app.delete('/provider-connections/:provider', async (c) => {
  const blocked = await requireSetupIncomplete(c)
  if (blocked) return blocked

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

app.post('/provider-connections/:provider/test', async (c) => {
  const blocked = await requireSetupIncomplete(c)
  if (blocked) return blocked

  return handleProviderConnectionTest(c)
})

// ── Google OAuth client credentials (env-only) ────
app.get('/google-oauth', (c) => {
  return c.json({
    success: true,
    data: { configured: settingsService.isGoogleOAuthConfigured() },
  })
})

app.post('/google-oauth/test', async (c) => {
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

  // 1. Validate client credentials via dummy token exchange
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

  // 2. Find a connected workspace with a refresh token to test API access
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

  // 3. Refresh the access token
  let accessToken: string
  try {
    const creds = JSON.parse(decrypted.gwsCredentialsFile as string) as { refresh_token: string }
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: creds.refresh_token,
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

  // 4. Test each API with a lightweight call
  const apiTests = {
    gmail: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    calendar: 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1',
    drive: 'https://www.googleapis.com/drive/v3/about?fields=user',
  } as const

  const apis: Record<string, boolean> = {}
  await Promise.all(
    Object.entries(apiTests).map(async ([name, url]) => {
      try {
        const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
        apis[name] = r.ok
      } catch {
        apis[name] = false
      }
    }),
  )
  result.apis = apis as { gmail: boolean; calendar: boolean; drive: boolean }

  return c.json({ success: true, data: result })
})

// ── Docker image preparation ──────────────────────

interface ImageTaskState {
  status: 'idle' | 'pulling' | 'done' | 'error'
  progress: string
  error?: string
}

const imageState: { sandbox: ImageTaskState } = {
  sandbox: { status: 'idle', progress: '' },
}

function overallStatus(): { status: string; sandbox: ImageTaskState } {
  const sb = imageState.sandbox
  return { status: sb.status, sandbox: sb }
}

app.post('/pull-images', async (c) => {
  // ── Sandbox base build ──
  if (imageState.sandbox.status !== 'pulling') {
    ;(async () => {
      imageState.sandbox = { status: 'pulling', progress: 'Checking base image...' }
      try {
        await imageBuilderService.ensureBaseImage((line) => {
          imageState.sandbox = { status: 'pulling', progress: line }
        })
        imageState.sandbox = { status: 'done', progress: 'Base image ready' }
      } catch (err) {
        imageState.sandbox = {
          status: 'error',
          progress: '',
          error: err instanceof Error ? err.message : String(err),
        }
      }
    })()
  }

  return c.json({ success: true, data: overallStatus() })
})

app.get('/pull-images/status', (c) => {
  return c.json({ success: true, data: overallStatus() })
})

// ── Preflight checks ──────────────────────────────
app.post('/preflight', async (c) => {
  const blocked = await requireSetupIncomplete(c)
  if (blocked) return blocked

  const body = await c.req.json()
  const { capabilities, browserGridUrl } = body as {
    capabilities?: string[]
    browserGridUrl?: string
  }
  const selectedCaps = new Set(capabilities ?? [])

  const settings = await settingsService.get()

  interface CheckResult {
    name: string
    status: 'pass' | 'fail' | 'skip'
    message: string
    durationMs: number
  }

  const checks: CheckResult[] = []

  async function runCheck(
    name: string,
    fn: () => Promise<{ status: 'pass' | 'fail'; message: string }>,
    condition = true,
  ) {
    if (!condition) {
      checks.push({ name, status: 'skip', message: 'Not configured', durationMs: 0 })
      return
    }
    const start = Date.now()
    try {
      const result = await fn()
      checks.push({ name, ...result, durationMs: Date.now() - start })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[Preflight] ${name} failed (${Date.now() - start}ms):`, message)
      checks.push({
        name,
        status: 'fail',
        message,
        durationMs: Date.now() - start,
      })
    }
  }

  // 1. AI Providers — test each configured LLM provider
  const { discoverLLMModels, discoverEmbeddingModels } =
    await import('../services/model-discovery.service.js')
  const configured = await settingsService.getConfiguredProviders()
  const metadata = settingsService.getProviderMetadata()

  for (const provider of configured.llm) {
    const label = metadata[provider as keyof typeof metadata]?.label ?? provider
    await runCheck(`${label} Connection`, async () => {
      const models = await discoverLLMModels(provider)
      if (!models.length) {
        return { status: 'fail', message: `No models discovered for ${provider}` }
      }

      return {
        status: 'pass',
        message: `${label} credentials are valid (${models.length} models available)`,
      }
    })
  }

  // 2. Embedding Provider — validate catalog only, without running a model
  await runCheck('Embedding Provider', async () => {
    const provider = settings.embeddingProvider
    const connectionValue = await settingsService.getProviderConnectionValue(provider)
    if (!connectionValue) return { status: 'fail', message: `No connection for ${provider}` }

    const models = await discoverEmbeddingModels(provider)
    if (!models.length) {
      return { status: 'fail', message: `No embedding models discovered for ${provider}` }
    }

    return {
      status: 'pass',
      message: `${provider} credentials are valid (${models.length} embedding models available)`,
    }
  })

  // 3. Qdrant connectivity
  await runCheck('Qdrant', async () => {
    const collections = await qdrant.getCollections()
    return { status: 'pass', message: `Connected — ${collections.collections.length} collections` }
  })

  // 4. S3 / MinIO connectivity
  await runCheck('Object Storage (S3)', async () => {
    const result = await s3.send(new ListBucketsCommand({}))
    const bucketNames = (result.Buckets ?? []).map((b) => b.Name)
    const hasBucket = bucketNames.includes(env.MINIO_BUCKET)
    return {
      status: 'pass',
      message: hasBucket
        ? `Connected — bucket "${env.MINIO_BUCKET}" exists`
        : `Connected — bucket "${env.MINIO_BUCKET}" will be created`,
    }
  })

  // 5. Google OAuth (if configured)
  await runCheck(
    'Google OAuth',
    async () => {
      const creds = await settingsService.getGoogleCredentials()
      if (!creds) return { status: 'fail', message: 'Credentials not found' }

      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: 'test_dummy_code',
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          redirect_uri: 'http://localhost',
          grant_type: 'authorization_code',
        }),
      })
      const data = (await res.json()) as { error?: string }
      if (data.error === 'invalid_client') {
        return { status: 'fail', message: 'Invalid Client ID or Client Secret' }
      }
      // invalid_grant or redirect_uri_mismatch means credentials are valid
      return { status: 'pass', message: 'Client credentials are valid' }
    },
    settingsService.isGoogleOAuthConfigured(),
  )

  // 6. BrowserGrid (if selected)
  await runCheck(
    'BrowserGrid',
    async () => {
      const url = process.env.BROWSER_GRID_URL || browserGridUrl || 'http://localhost:9090'
      const res = await fetch(`${url}/api/health`, {
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return { status: 'fail', message: `Health check returned ${res.status}` }
      return { status: 'pass', message: `Reachable at ${url}` }
    },
    selectedCaps.has('browser-automation'),
  )

  // 7. Docker — verify daemon is accessible
  await runCheck('Docker', async () => {
    const docker = new Docker()
    const info = await docker.info()
    return {
      status: 'pass',
      message: `Docker ${info.ServerVersion} — ${info.Containers} containers`,
    }
  })

  // 8. Sandbox image — verify base image exists
  await runCheck('Sandbox Base Image', async () => {
    const docker = new Docker()
    try {
      const img = await docker.getImage(SANDBOX_BASE_IMAGE).inspect()
      const sizeMB = Math.round((img.Size ?? 0) / 1024 / 1024)
      return { status: 'pass', message: `Image ready (${sizeMB}MB)` }
    } catch {
      return { status: 'fail', message: 'Base image not found — build it in the Docker step' }
    }
  })

  // 9. Sandbox spin-up test — create and immediately destroy a test container
  await runCheck('Sandbox Spin-up', async () => {
    const docker = new Docker()
    let image = SANDBOX_BASE_IMAGE
    try {
      await docker.getImage(image).inspect()
    } catch {
      image = 'ubuntu:22.04'
      try {
        await docker.getImage(image).inspect()
      } catch {
        return { status: 'fail', message: 'No sandbox image available to test' }
      }
    }

    const container = await docker.createContainer({
      Image: image,
      Cmd: ['echo', 'preflight-ok'],
      HostConfig: {
        Memory: 64 * 1024 * 1024,
        NanoCpus: 500_000_000,
        NetworkMode: 'none',
        AutoRemove: true,
      },
      Labels: { 'clawbuddy.type': 'preflight-test' },
    })
    await container.start()
    const { StatusCode } = await container.wait()
    // AutoRemove handles cleanup
    if (StatusCode !== 0) {
      return { status: 'fail', message: `Container exited with code ${StatusCode}` }
    }
    return { status: 'pass', message: 'Container started and executed successfully' }
  })

  const allPassed = checks.every((c) => c.status === 'pass' || c.status === 'skip')

  return c.json({
    success: true,
    data: { checks, allPassed },
  })
})

// ── Import workspace config during setup ─────────────────
app.post('/import', async (c) => {
  const blocked = await requireSetupIncomplete(c)
  if (blocked) return blocked

  const body = await c.req.json()
  const parsed = validateBody(workspaceExportSchema, body)

  // Apply model config including embedding (safe during setup — embedding is only locked after onboarding)
  try {
    if (
      typeof parsed.modelConfig.localBaseUrl === 'string' &&
      parsed.modelConfig.localBaseUrl.trim()
    ) {
      await settingsService.setProviderConnection('local', parsed.modelConfig.localBaseUrl)
      invalidateModelCache('local')
    }

    await settingsService.update({
      aiProvider: parsed.modelConfig.aiProvider,
      aiModel: parsed.modelConfig.aiModel ?? undefined,
      roleProviders: parsed.modelConfig.roleProviders as
        | Partial<
            Record<
              'primary' | 'medium' | 'light' | 'explore' | 'execute' | 'title' | 'compact',
              string
            >
          >
        | undefined,
      mediumModel: parsed.modelConfig.mediumModel ?? undefined,
      lightModel: parsed.modelConfig.lightModel ?? undefined,
      exploreModel: parsed.modelConfig.exploreModel ?? undefined,
      executeModel: parsed.modelConfig.executeModel ?? undefined,
      titleModel: parsed.modelConfig.titleModel ?? undefined,
      compactModel: parsed.modelConfig.compactModel ?? undefined,
      advancedModelConfig: parsed.modelConfig.advancedModelConfig,
      embeddingProvider: parsed.modelConfig.embeddingProvider,
      embeddingModel: parsed.modelConfig.embeddingModel ?? undefined,
      contextLimitTokens: parsed.modelConfig.contextLimitTokens,
      maxAgentIterations: parsed.modelConfig.maxAgentIterations,
      subAgentExploreMaxIterations: parsed.modelConfig.subAgentExploreMaxIterations,
      subAgentAnalyzeMaxIterations: parsed.modelConfig.subAgentAnalyzeMaxIterations,
      subAgentExecuteMaxIterations: parsed.modelConfig.subAgentExecuteMaxIterations,
      timezone: parsed.modelConfig.timezone ?? undefined,
    })
  } catch {
    // Model config may fail if provider keys aren't set yet — that's OK during setup
  }

  // Return parsed data for the frontend to pre-fill the wizard
  return c.json({
    success: true,
    data: {
      workspace: parsed.workspace,
      capabilities: parsed.capabilities,
      channels: parsed.channels,
      modelConfig: parsed.modelConfig,
    },
  })
})

app.post('/complete', async (c) => {
  const blocked = await requireSetupIncomplete(c)
  if (blocked) return blocked

  const body = await c.req.json()
  const {
    capabilities,
    capabilityConfigs,
    workspaceName,
    workspaceColor,
    telegramBotToken,
    telegramTokenTested,
    timezone,
    // Chat model config (deferred from wizard step)
    llm,
    llmModel,
    mediumModel,
    lightModel,
    exploreModel,
    executeModel,
    titleModel,
    compactModel,
    advancedModelConfig,
    roleProviders,
  } = body

  // Apply chat model config before validation
  await settingsService.update({
    ...(llm !== undefined ? { aiProvider: llm } : {}),
    ...(llmModel !== undefined ? { aiModel: llmModel } : {}),
    ...(mediumModel !== undefined ? { mediumModel } : {}),
    ...(lightModel !== undefined ? { lightModel } : {}),
    ...(exploreModel !== undefined ? { exploreModel } : {}),
    ...(executeModel !== undefined ? { executeModel } : {}),
    ...(titleModel !== undefined ? { titleModel } : {}),
    ...(compactModel !== undefined ? { compactModel } : {}),
    ...(advancedModelConfig !== undefined ? { advancedModelConfig } : {}),
    ...(roleProviders !== undefined ? { roleProviders } : {}),
  })

  const settings = await settingsService.get()
  const available = await settingsService.getAvailableProviders()

  // Validate embedding provider is configured and catalog-backed
  const embeddingProvider = settings.embeddingProvider
  if (!available.embedding.includes(embeddingProvider as (typeof available.embedding)[number])) {
    return c.json(
      {
        success: false,
        error: `Embedding provider "${embeddingProvider}" is not available`,
      },
      400,
    )
  }

  // Validate AI provider is configured and catalog-backed
  const aiProvider = settings.aiProvider
  if (!available.llm.includes(aiProvider as (typeof available.llm)[number])) {
    return c.json(
      {
        success: false,
        error: `AI provider "${aiProvider}" is not available`,
      },
      400,
    )
  }
  if (!settings.aiModel) {
    return c.json(
      {
        success: false,
        error: 'Select a primary AI model before completing setup',
      },
      400,
    )
  }

  // Create Qdrant collection with correct dimensions
  const vector = await embeddingService.embed('setup dimension probe')
  const dimensions = vector.length
  await searchService.ensureCollection(dimensions)

  // Create the first workspace
  const workspace = await prisma.workspace.create({
    data: {
      name: workspaceName || 'Default',
      color: workspaceColor || null,
    },
  })

  // Save timezone if provided
  if (timezone !== undefined) {
    await settingsService.update({ timezone })
  }

  // Mark onboarding as complete
  await settingsService.completeOnboarding()

  // Enable base capabilities on the workspace
  const baseSlugs = [
    'document-search',
    'bash',
    'agent-memory',
    'cron-management',
    'python',
    'web-fetch',
    'sub-agent-delegation',
    'dashboard-management',
  ]

  // Auto-enable capabilities whose required API key is available
  for (const [slug, provider] of Object.entries(capabilityService.REQUIRES_API_KEY)) {
    const key = await settingsService.getApiKey(provider)
    if (key && !baseSlugs.includes(slug)) baseSlugs.push(slug)
  }

  for (const slug of baseSlugs) {
    try {
      await capabilityService.enableCapability(workspace.id, slug)
    } catch {
      // Capability may not exist yet if sync hasn't run
    }
  }

  // Enable additional selected capabilities
  if (Array.isArray(capabilities) && capabilities.length > 0) {
    for (const slug of capabilities) {
      if (baseSlugs.includes(slug)) continue
      try {
        const config = capabilityConfigs?.[slug]
        await capabilityService.enableCapability(workspace.id, slug, config)
      } catch {
        // Capability may not exist yet if sync hasn't run
      }
    }
  }

  // Create Telegram channel if token provided
  if (telegramBotToken && typeof telegramBotToken === 'string') {
    const { channelService } = await import('../services/channel.service.js')
    const channel = await channelService.create({
      workspaceId: workspace.id,
      type: 'telegram',
      name: 'Telegram',
      config: { botToken: telegramBotToken },
    })

    // Auto-enable if token was successfully tested during onboarding
    if (telegramTokenTested) {
      try {
        const { telegramBotManager } = await import('../channels/telegram/telegram-bot-manager.js')
        const botUsername = await telegramBotManager.startBot(
          channel.id,
          telegramBotToken,
          workspace.id,
        )
        await channelService.update(channel.id, { config: { botUsername } })
        await channelService.enable(channel.id)
      } catch (err) {
        console.error('[Setup] Failed to auto-enable Telegram channel:', err)
      }
    }
  }

  // Index capabilities with the user's chosen embedding model (non-blocking)
  toolDiscoveryService.indexCapabilities().catch((err) => {
    console.error('[Setup] Failed to index capabilities:', err)
  })

  return c.json({
    success: true,
    data: {
      onboardingComplete: true,
      workspace,
    },
  })
})

export default app
