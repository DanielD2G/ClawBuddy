import { OpenAPIHono } from '@hono/zod-openapi'
import { swaggerUI } from '@hono/swagger-ui'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { errorHandler } from './middleware/error-handler.js'
import workspaceRoutes from './routes/workspaces.js'
import folderRoutes from './routes/folders.js'
import documentRoutes from './routes/documents.js'
import searchRoutes from './routes/search.js'
import chatRoutes from './routes/chat.js'
import statsRoutes from './routes/stats.js'
import settingsRoutes from './routes/settings.js'
import adminRoutes from './routes/admin.js'
import setupRoutes from './routes/setup.js'
import capabilityRoutes from './routes/capabilities.js'
import fileRoutes from './routes/files.js'
import skillRoutes from './routes/skills.js'
import cronRoutes from './routes/cron.js'
import oauthRoutes from './routes/oauth.js'
import browserRoutes from './routes/browser.js'

const app = new OpenAPIHono()

// Global middleware
app.use('*', cors())
app.use('*', logger())

// Error handler
app.onError(errorHandler)

// Health check & docs
app.get('/api/health', (c) => {
  return c.json({ success: true, data: { status: 'ok' } })
})

app.doc('/api/openapi', {
  openapi: '3.1.0',
  info: {
    title: 'AgentBuddy API',
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
app.route('/api', statsRoutes)
app.route('/api', settingsRoutes)
app.route('/api', adminRoutes)
app.route('/api', capabilityRoutes)
app.route('/api', fileRoutes)
app.route('/api', skillRoutes)
app.route('/api', cronRoutes)
app.route('/api/oauth', oauthRoutes)
app.route('/api/browser', browserRoutes)

export default app
