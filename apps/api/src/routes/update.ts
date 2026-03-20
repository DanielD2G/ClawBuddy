import { Hono } from 'hono'
import Docker from 'dockerode'
import { ok, fail } from '../lib/responses.js'
import { env } from '../env.js'

const app = new Hono()
const docker = new Docker()

// ── In-memory cache for GitHub release check ────────
interface UpdateCache {
  data: UpdateCheckResult
  expiresAt: number
}

interface UpdateCheckResult {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseNotes: string
  publishedAt: string
}

let updateCache: UpdateCache | null = null
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// ── Mutex to prevent concurrent updates ─────────────
let isUpdating = false

// ── Semver comparison ───────────────────────────────
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const na = pa[i] ?? 0
    const nb = pb[i] ?? 0
    if (na !== nb) return na - nb
  }
  return 0
}

function stripLeadingV(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag
}

// ── GET /admin/update/version ───────────────────────
app.get('/admin/update/version', (c) => {
  return ok(c, { currentVersion: env.APP_VERSION })
})

// ── GET /admin/update/check ─────────────────────────
app.get('/admin/update/check', async (c) => {
  const currentVersion = env.APP_VERSION

  // Return cached result if still valid
  if (updateCache && Date.now() < updateCache.expiresAt) {
    return ok(c, { ...updateCache.data, currentVersion })
  }

  try {
    const res = await fetch(
      'https://api.github.com/repos/DanielD2G/ClawBuddy/releases/latest',
      {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'ClawBuddy-Update-Checker',
        },
      },
    )

    if (!res.ok) {
      return fail(c, `GitHub API returned ${res.status}`, 500)
    }

    const release = (await res.json()) as {
      tag_name: string
      body: string | null
      published_at: string
    }

    const latestVersion = stripLeadingV(release.tag_name)
    const updateAvailable = compareSemver(latestVersion, currentVersion) > 0

    const result: UpdateCheckResult = {
      currentVersion,
      latestVersion,
      updateAvailable,
      releaseNotes: release.body ?? '',
      publishedAt: release.published_at,
    }

    // Cache the result
    updateCache = { data: result, expiresAt: Date.now() + CACHE_TTL_MS }

    return ok(c, result)
  } catch {
    return fail(c, 'Could not check for updates. Check your internet connection.', 500)
  }
})

// ── POST /admin/update/apply ────────────────────────
app.post('/admin/update/apply', async (c) => {
  if (isUpdating) {
    return fail(c, 'Update already in progress', 409)
  }

  const body = await c.req.json<{ version: string }>()
  const version = body.version

  if (!version || typeof version !== 'string') {
    return fail(c, 'Missing or invalid version', 400)
  }

  isUpdating = true

  // Fire the update in background — response is sent before the container dies
  void updateServices(version).catch((err) => {
    console.error('[update] Failed to update services:', err)
    isUpdating = false
  })

  return ok(c, { message: 'Update initiated' })
})

// ── Docker Swarm service update logic ───────────────
async function updateServices(version: string) {
  const STACK_NAME = 'clawbuddy'
  const images = {
    web: `ghcr.io/danield2g/clawbuddy-web:${version}`,
    api: `ghcr.io/danield2g/clawbuddy-api:${version}`,
  }

  console.log(`[update] Starting update to version ${version}`)

  // Step 1: Pull new images
  console.log('[update] Pulling new images...')
  for (const [name, image] of Object.entries(images)) {
    console.log(`[update]   Pulling ${name}: ${image}`)
    await new Promise<void>((resolve, reject) => {
      docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err)
        // Follow pull progress to completion
        docker.modem.followProgress(stream, (err: Error | null) => {
          if (err) return reject(err)
          resolve()
        })
      })
    })
  }
  console.log('[update] All images pulled successfully')

  // Step 2: Update web service first (static, restarts fast)
  console.log('[update] Updating web service...')
  await updateSwarmService(`${STACK_NAME}_web`, images.web)

  // Step 3: Update API service last (this kills the current process)
  console.log('[update] Updating API service (this container will restart)...')
  await updateSwarmService(`${STACK_NAME}_api`, images.api)
}

async function updateSwarmService(serviceName: string, newImage: string) {
  const service = docker.getService(serviceName)
  const info = await service.inspect()

  const spec = info.Spec
  spec.TaskTemplate.ContainerSpec.Image = newImage

  await service.update({
    ...spec,
    version: info.Version.Index,
  })
}

export default app
