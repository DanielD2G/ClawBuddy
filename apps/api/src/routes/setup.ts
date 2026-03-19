import { Hono } from 'hono'
import type { Context } from 'hono'
import { settingsService } from '../services/settings.service.js'
import { buildModelCatalogs, invalidateModelCache } from '../services/model-discovery.service.js'
import { searchService } from '../services/search.service.js'
import { capabilityService } from '../services/capability.service.js'
import { toolDiscoveryService } from '../services/tool-discovery.service.js'
import { prisma } from '../lib/prisma.js'
import { EMBEDDING_DIMENSIONS } from '@agentbuddy/shared'
import { imageBuilderService } from '../services/image-builder.service.js'
import { qdrant } from '../lib/qdrant.js'
import { s3 } from '../lib/s3.js'
import { embeddingService } from '../services/embedding.service.js'
import { env } from '../env.js'
import { TOOL_DISCOVERY_COLLECTION } from '../constants.js'
import { ListBucketsCommand } from '@aws-sdk/client-s3'
import Docker from 'dockerode'

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

  const settings = await settingsService.get()
  const available = await settingsService.getAvailableProviders()
  const apiKeys = await settingsService.getMaskedKeys()

  const models = await buildModelCatalogs(available)

  return c.json({
    success: true,
    data: {
      providers: {
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
          embedding: settings.embeddingProvider,
          embeddingModel: settings.embeddingModel,
        },
        available,
        models,
      },
      apiKeys,
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
  })
  return c.json({
    success: true,
    data: {
      active: {
        llm: settings.aiProvider,
        llmModel: settings.aiModel,
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

app.put('/api-keys/:provider', async (c) => {
  const blocked = await requireSetupIncomplete(c)
  if (blocked) return blocked

  const { provider } = c.req.param()
  const { key } = await c.req.json()
  if (!key || typeof key !== 'string') {
    return c.json({ success: false, error: 'key is required' }, 400)
  }
  await settingsService.setApiKey(provider, key)
  invalidateModelCache(provider)
  const apiKeys = await settingsService.getMaskedKeys()
  return c.json({ success: true, data: { apiKeys } })
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
    where: { capabilityId: gwsCap.id, enabled: true, config: { not: null as any } },
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

  // 1. AI Provider API Keys — test each configured LLM provider
  const { createLLMForModel } = await import('../providers/index.js')
  const { DEFAULT_LLM_MODELS } = await import('../config.js')
  const available = await settingsService.getAvailableProviders()

  const PROVIDER_NAMES: Record<string, string> = {
    openai: 'OpenAI',
    gemini: 'Google Gemini',
    claude: 'Anthropic Claude',
  }

  for (const provider of available.llm) {
    const label = PROVIDER_NAMES[provider] ?? provider
    await runCheck(`${label} API Key`, async () => {
      const model = DEFAULT_LLM_MODELS[provider]
      if (!model) return { status: 'fail', message: `No default model for ${provider}` }

      const llm = await createLLMForModel(model)
      await llm.chat([{ role: 'user', content: 'Say ok' }], { maxTokens: 5, temperature: 0 })
      return { status: 'pass', message: `${label} key is valid (${model})` }
    })
  }

  // 2. Embedding Provider API Key — generate a test embedding
  await runCheck('Embedding Provider', async () => {
    const provider = settings.embeddingProvider
    const apiKey = await settingsService.getApiKey(provider)
    if (!apiKey) return { status: 'fail', message: `No API key for ${provider}` }

    const vector = await embeddingService.embed('preflight test')
    const embeddingModel = settings.embeddingModel ?? 'unknown'
    const expectedDimensions = EMBEDDING_DIMENSIONS[embeddingModel]
    if (expectedDimensions && vector.length !== expectedDimensions) {
      return {
        status: 'fail',
        message: `Dimension mismatch: model ${embeddingModel} returned ${vector.length}d, expected ${expectedDimensions}d`,
      }
    }
    return {
      status: 'pass',
      message: `${provider} (${embeddingModel}) — ${vector.length}d vectors`,
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
      const img = await docker.getImage('agentbuddy-sandbox-base').inspect()
      const sizeMB = Math.round((img.Size ?? 0) / 1024 / 1024)
      return { status: 'pass', message: `Image ready (${sizeMB}MB)` }
    } catch {
      return { status: 'fail', message: 'Base image not found — build it in the Docker step' }
    }
  })

  // 9. Sandbox spin-up test — create and immediately destroy a test container
  await runCheck('Sandbox Spin-up', async () => {
    const docker = new Docker()
    let image = 'agentbuddy-sandbox-base'
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
      Labels: { 'agentbuddy.type': 'preflight-test' },
    })
    await container.start()
    const { StatusCode } = await container.wait()
    // AutoRemove handles cleanup
    if (StatusCode !== 0) {
      return { status: 'fail', message: `Container exited with code ${StatusCode}` }
    }
    return { status: 'pass', message: 'Container started and executed successfully' }
  })

  // 10. Tool Discovery index — check Qdrant collection has the right dimensions (skip during initial setup)
  await runCheck(
    'Tool Discovery Index',
    async () => {
      try {
        const info = await qdrant.getCollection(TOOL_DISCOVERY_COLLECTION)
        const size = (info.config.params.vectors as { size: number }).size
        const points = info.points_count

        // Verify dimensions match the configured embedding model
        const embeddingModel = settings.embeddingModel ?? 'unknown'
        const expectedDimensions = EMBEDDING_DIMENSIONS[embeddingModel]
        if (expectedDimensions && size !== expectedDimensions) {
          return {
            status: 'fail',
            message: `Dimension mismatch: collection has ${size}d but model ${embeddingModel} produces ${expectedDimensions}d — restart the API to re-index`,
          }
        }
        return { status: 'pass', message: `${points} capabilities indexed (${size}d vectors)` }
      } catch {
        return {
          status: 'fail',
          message: `Collection "${TOOL_DISCOVERY_COLLECTION}" not found — restart the API to create it`,
        }
      }
    },
    settings.onboardingComplete,
  )

  const allPassed = checks.every((c) => c.status === 'pass' || c.status === 'skip')

  return c.json({
    success: true,
    data: { checks, allPassed },
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
  } = body

  const settings = await settingsService.get()

  // Validate embedding provider has an API key
  const embeddingProvider = settings.embeddingProvider
  const embeddingKey = await settingsService.getApiKey(embeddingProvider)
  if (!embeddingKey) {
    return c.json(
      {
        success: false,
        error: `No API key configured for embedding provider: ${embeddingProvider}`,
      },
      400,
    )
  }

  // Validate AI provider has an API key
  const aiProvider = settings.aiProvider
  const aiKey = await settingsService.getApiKey(aiProvider)
  if (!aiKey) {
    return c.json(
      {
        success: false,
        error: `No API key configured for AI provider: ${aiProvider}`,
      },
      400,
    )
  }

  // Create Qdrant collection with correct dimensions
  const embeddingModel =
    settings.embeddingModel ??
    (embeddingProvider === 'openai' ? 'text-embedding-3-small' : 'gemini-embedding-001')
  const dimensions = EMBEDDING_DIMENSIONS[embeddingModel] ?? 1536
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
