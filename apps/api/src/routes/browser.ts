import { Hono } from 'hono'
import { settingsService } from '../services/settings.service.js'
import { browserService } from '../services/browser.service.js'

const app = new Hono()

// GET /api/browser/config — current browser configuration
app.get('/config', async (c) => {
  try {
    const [url, browser, browserModel] = await Promise.all([
      settingsService.getBrowserGridUrl(),
      settingsService.getBrowserGridBrowser(),
      settingsService.getBrowserModel(),
    ])
    const apiKey = await settingsService.getBrowserGridApiKey()

    return c.json({
      success: true,
      data: {
        url,
        hasApiKey: !!apiKey,
        browser,
        browserModel,
      },
    })
  } catch (error) {
    return c.json({ success: false, error: 'Failed to get browser config' }, 500)
  }
})

// PATCH /api/browser/config — update browser configuration
app.patch('/config', async (c) => {
  try {
    const body = await c.req.json()
    const { url, apiKey, browser, browserModel } = body as {
      url?: string
      apiKey?: string
      browser?: string
      browserModel?: string
    }

    // Validate browser
    if (browser && !['chromium', 'firefox', 'camoufox'].includes(browser)) {
      return c.json({ success: false, error: 'Invalid browser. Must be "chromium", "firefox", or "camoufox".' }, 400)
    }

    // Update settings (non-sensitive fields)
    const updateData: Record<string, string | undefined> = {}
    if (url) updateData.browserGridUrl = url
    if (browser) updateData.browserGridBrowser = browser
    if (browserModel !== undefined) updateData.browserModel = browserModel || undefined

    if (Object.keys(updateData).length) {
      await settingsService.update(updateData)
    }

    // Handle API key separately (encrypted)
    if (apiKey !== undefined) {
      if (apiKey === '') {
        await settingsService.setBrowserGridApiKey('')
      } else {
        await settingsService.setBrowserGridApiKey(apiKey)
      }
    }

    return c.json({ success: true })
  } catch (error) {
    return c.json({ success: false, error: 'Failed to update browser config' }, 500)
  }
})

// GET /api/browser/health — health check
app.get('/health', async (c) => {
  try {
    const healthy = await browserService.healthCheck()
    return c.json({
      success: true,
      data: { healthy },
    })
  } catch {
    return c.json({
      success: true,
      data: { healthy: false },
    })
  }
})

// GET /api/browser/sessions — active sessions
app.get('/sessions', (c) => {
  const sessions = browserService.getActiveSessions()
  return c.json({
    success: true,
    data: { sessions },
  })
})

// DELETE /api/browser/sessions/:id — close session
app.delete('/sessions/:id', async (c) => {
  const id = c.req.param('id')
  await browserService.closeSession(id)
  return c.json({ success: true })
})

export default app
