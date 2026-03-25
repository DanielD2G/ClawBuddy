import { OpenAPIHono } from '@hono/zod-openapi'
import { swaggerUI } from '@hono/swagger-ui'
import type { Context, Next } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { serveStatic } from 'hono/bun'
import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import { errorHandler } from './middleware/error-handler.js'
import { env } from './env.js'
import workspaceRoutes from './routes/workspaces.js'
import folderRoutes from './routes/folders.js'
import documentRoutes from './routes/documents.js'
import searchRoutes from './routes/search.js'
import chatRoutes from './routes/chat.js'
import globalSettingsRoutes from './routes/global-settings.js'
import dataRoutes from './routes/data.js'
import setupRoutes from './routes/setup.js'
import capabilityRoutes from './routes/capabilities.js'
import fileRoutes from './routes/files.js'
import skillRoutes from './routes/skills.js'
import cronRoutes from './routes/cron.js'
import dashboardRoutes from './routes/dashboards.js'
import oauthRoutes from './routes/oauth.js'
import browserRoutes from './routes/browser.js'
import channelRoutes from './routes/channels.js'
import { startupService } from './services/startup.service.js'
import updateRoutes from './routes/update.js'
import { getBuildInfo } from './lib/build-info.js'

const app = new OpenAPIHono()
const STATIC_ROOT = './web'
const INDEX_HTML_PATH = `${STATIC_ROOT}/index.html`
const STATIC_GZIP_TYPES = new Set([
  'application/javascript',
  'application/json',
  'text/css',
  'text/javascript',
  'text/plain',
  'text/xml',
])

async function gzipStaticResponse(c: Context, next: Next) {
  await next()

  if (!['GET', 'HEAD'].includes(c.req.method)) return
  if (c.req.path.startsWith('/api/')) return
  if (!c.req.header('accept-encoding')?.includes('gzip')) return
  if (!c.res || c.res.headers.has('Content-Encoding') || !c.res.body) return

  const contentType = c.res.headers.get('content-type')?.split(';')[0]?.trim()
  if (!contentType || !STATIC_GZIP_TYPES.has(contentType)) return

  const headers = new Headers(c.res.headers)
  headers.set('Content-Encoding', 'gzip')
  headers.set('Vary', 'Accept-Encoding')
  headers.delete('Content-Length')

  c.res = new Response(c.res.body.pipeThrough(new CompressionStream('gzip')), {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  })
}

// Global middleware
app.use(
  '*',
  cors({
    origin: env.APP_URL,
    credentials: true,
  }),
)
app.use('*', logger())

// Error handler
app.onError(errorHandler)

// Health check & docs
app.get('/api/health', (c) => {
  const startup = startupService.getState()
  const status = startup.ready ? 200 : 503
  const build = getBuildInfo()

  return c.json(
    {
      success: startup.ready,
      data: {
        version: build.version,
        commitSha: build.commitSha,
        builtAt: build.builtAt,
        status: startup.ready ? 'ok' : 'starting',
        phase: startup.phase,
        attempt: startup.attempt,
        startedAt: startup.startedAt,
        lastReadyAt: startup.lastReadyAt,
        lastError: startup.lastError,
        checks: startup.checks,
      },
    },
    status,
  )
})

app.doc('/api/openapi', {
  openapi: '3.1.0',
  info: {
    title: 'ClawBuddy API',
    version: '0.0.0',
  },
})

app.get('/api/docs', swaggerUI({ url: '/api/openapi' }))

// Mount routes
app.route('/api/setup', setupRoutes)
app.route('/api/workspaces', workspaceRoutes)
app.route('/api', folderRoutes)
app.route('/api', documentRoutes)
app.route('/api', searchRoutes)
app.route('/api', chatRoutes)
app.route('/api', globalSettingsRoutes)
app.route('/api', dataRoutes)
app.route('/api', capabilityRoutes)
app.route('/api', fileRoutes)
app.route('/api', skillRoutes)
app.route('/api', cronRoutes)
app.route('/api', dashboardRoutes)
app.route('/api/oauth', oauthRoutes)
app.route('/api/browser', browserRoutes)
app.route('/api/channels', channelRoutes)
app.route('/api', updateRoutes)

if (existsSync(INDEX_HTML_PATH)) {
  const serveWebAsset = serveStatic({ root: STATIC_ROOT })

  app.use('*', gzipStaticResponse)
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/api/')) {
      return next()
    }

    return serveWebAsset(c, next)
  })

  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.notFound()
    }

    if (extname(c.req.path)) {
      return c.notFound()
    }

    const html = await Bun.file(INDEX_HTML_PATH).text()
    return c.html(html)
  })
}

export default app
