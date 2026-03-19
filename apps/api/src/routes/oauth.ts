import { Hono } from 'hono'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { encrypt, decrypt } from '../services/crypto.service.js'
import { encryptConfigFields } from '../services/config-validation.service.js'
import { settingsService } from '../services/settings.service.js'
import type { ConfigFieldDefinition } from '../capabilities/types.js'

const app = new Hono()

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'

const SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ')

function getRedirectUri(): string {
  const appUrl = process.env.APP_URL || 'http://localhost:4321'
  return `${appUrl}/api/oauth/google/callback`
}

async function getGoogleCredentials(): Promise<{ clientId: string; clientSecret: string }> {
  const creds = await settingsService.getGoogleCredentials()
  if (!creds) throw new Error('Google OAuth client credentials not configured')
  return { clientId: creds.clientId, clientSecret: creds.clientSecret }
}

// ── GET /google/authorize ───────────────────────────────────
app.get('/google/authorize', async (c) => {
  const workspaceId = c.req.query('workspaceId')
  const capabilitySlug = c.req.query('capabilitySlug')

  if (!workspaceId || !capabilitySlug) {
    return c.json({ success: false, error: 'workspaceId and capabilitySlug are required' }, 400)
  }

  const { clientId } = await getGoogleCredentials()

  // Encrypt state to prevent tampering
  const state = encrypt(JSON.stringify({ workspaceId, capabilitySlug }))

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  })

  return c.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`)
})

// ── GET /google/callback ────────────────────────────────────
app.get('/google/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const error = c.req.query('error')

  if (error) {
    return c.redirect(`/settings/capabilities?oauth=error&message=${encodeURIComponent(error)}`)
  }

  if (!code || !state) {
    return c.redirect('/settings/capabilities?oauth=error&message=Missing+code+or+state')
  }

  let stateData: { workspaceId: string; capabilitySlug: string }
  try {
    stateData = JSON.parse(decrypt(state))
  } catch {
    return c.redirect('/settings/capabilities?oauth=error&message=Invalid+state')
  }

  const { clientId, clientSecret } = await getGoogleCredentials()

  // Exchange code for tokens
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: getRedirectUri(),
      grant_type: 'authorization_code',
    }),
  })

  if (!tokenRes.ok) {
    const err = await tokenRes.text()
    console.error('[OAuth] Token exchange failed:', err)
    return c.redirect('/settings/capabilities?oauth=error&message=Token+exchange+failed')
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string
    refresh_token?: string
    token_type: string
    expires_in: number
  }

  if (!tokens.refresh_token) {
    return c.redirect(
      '/settings/capabilities?oauth=error&message=No+refresh+token.+Try+revoking+access+at+myaccount.google.com',
    )
  }

  // Fetch user email
  let email = 'unknown'
  try {
    const userRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    if (userRes.ok) {
      const userInfo = (await userRes.json()) as { email: string }
      email = userInfo.email
    }
  } catch {
    // Non-critical
  }

  // Build GWS CLI credentials file content
  const gwsCredentials = JSON.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
    type: 'authorized_user',
  })

  // Store in WorkspaceCapability.config
  const capability = await prisma.capability.findUnique({
    where: { slug: stateData.capabilitySlug },
  })

  if (!capability) {
    return c.redirect('/settings/capabilities?oauth=error&message=Capability+not+found')
  }

  const schema = capability.configSchema as ConfigFieldDefinition[] | null
  const config = encryptConfigFields(schema ?? [], {
    gwsCredentialsFile: gwsCredentials,
    email,
  })

  await prisma.workspaceCapability.upsert({
    where: {
      workspaceId_capabilityId: {
        workspaceId: stateData.workspaceId,
        capabilityId: capability.id,
      },
    },
    create: {
      workspaceId: stateData.workspaceId,
      capabilityId: capability.id,
      enabled: true,
      config: config as Prisma.InputJsonValue,
    },
    update: {
      enabled: true,
      config: config as Prisma.InputJsonValue,
    },
  })

  // Destroy active sandboxes so they pick up new credentials
  const activeSandboxes = await prisma.sandboxSession.findMany({
    where: { workspaceId: stateData.workspaceId, status: 'running' },
  })
  if (activeSandboxes.length) {
    const { sandboxService } = await import('../services/sandbox.service.js')
    for (const s of activeSandboxes) {
      await sandboxService.destroySandbox(s.id).catch(() => {})
    }
  }

  // Also stop workspace container so it recreates with new env
  try {
    const { sandboxService } = await import('../services/sandbox.service.js')
    await sandboxService.stopWorkspaceContainer(stateData.workspaceId)
  } catch {
    /* ok */
  }

  return c.redirect(`/workspaces/${stateData.workspaceId}?oauth=success`)
})

// ── DELETE /google/disconnect ───────────────────────────────
app.delete('/google/disconnect', async (c) => {
  const { workspaceId, capabilitySlug } = await c.req.json()

  if (!workspaceId || !capabilitySlug) {
    return c.json({ success: false, error: 'workspaceId and capabilitySlug are required' }, 400)
  }

  const capability = await prisma.capability.findUnique({
    where: { slug: capabilitySlug },
  })

  if (!capability) {
    return c.json({ success: false, error: 'Capability not found' }, 404)
  }

  await prisma.workspaceCapability.updateMany({
    where: {
      workspaceId,
      capabilityId: capability.id,
    },
    data: {
      config: Prisma.DbNull,
      enabled: false,
    },
  })

  // Stop workspace container so it restarts without GWS credentials
  try {
    const { sandboxService } = await import('../services/sandbox.service.js')
    await sandboxService.stopWorkspaceContainer(workspaceId)
  } catch {
    /* ok */
  }

  return c.json({ success: true })
})

export default app
