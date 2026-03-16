import { Hono } from 'hono'
import { settingsService, MODEL_CATALOG } from '../services/settings.service.js'
import { searchService } from '../services/search.service.js'
import { capabilityService } from '../services/capability.service.js'
import { prisma } from '../lib/prisma.js'
import { EMBEDDING_DIMENSIONS } from '@agentbuddy/shared'
import { imageBuilderService } from '../services/image-builder.service.js'

const app = new Hono()

// Guard: reject if onboarding already done
async function requireSetupIncomplete(c: any): Promise<Response | null> {
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

  return c.json({
    success: true,
    data: {
      providers: {
        active: {
          llm: settings.aiProvider,
          llmModel: settings.aiModel,
          embedding: settings.embeddingProvider,
          embeddingModel: settings.embeddingModel,
        },
        available,
        models: MODEL_CATALOG,
      },
      apiKeys,
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
    embeddingProvider: body.embedding,
    embeddingModel: body.embeddingModel,
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

  const schema = gwsCap.configSchema as import('../capabilities/types.js').ConfigFieldDefinition[] | null
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
    const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string }
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
    })
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
    (async () => {
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

app.post('/complete', async (c) => {
  const blocked = await requireSetupIncomplete(c)
  if (blocked) return blocked

  const body = await c.req.json()
  const { capabilities, capabilityConfigs, workspaceName, workspaceColor } = body

  const settings = await settingsService.get()

  // Validate embedding provider has an API key
  const embeddingProvider = settings.embeddingProvider
  const embeddingKey = await settingsService.getApiKey(embeddingProvider)
  if (!embeddingKey) {
    return c.json({
      success: false,
      error: `No API key configured for embedding provider: ${embeddingProvider}`,
    }, 400)
  }

  // Validate AI provider has an API key
  const aiProvider = settings.aiProvider
  const aiKey = await settingsService.getApiKey(aiProvider)
  if (!aiKey) {
    return c.json({
      success: false,
      error: `No API key configured for AI provider: ${aiProvider}`,
    }, 400)
  }

  // Create Qdrant collection with correct dimensions
  const embeddingModel = settings.embeddingModel ??
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

  // Mark onboarding as complete
  await settingsService.completeOnboarding()

  // Enable base capabilities on the workspace
  const baseSlugs = ['document-search', 'bash', 'agent-memory', 'cron-management', 'python']
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

  return c.json({
    success: true,
    data: {
      onboardingComplete: true,
      workspace,
    },
  })
})

export default app
