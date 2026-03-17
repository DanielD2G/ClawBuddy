import { Hono } from 'hono'
import path from 'node:path'
import { storageService } from '../services/storage.service.js'
import { sanitizeFileName } from '../lib/sanitize.js'

const app = new Hono()

const ALLOWED_PREFIXES = ['generated/', 'uploads/']

app.get('/files/*', async (c) => {
  const raw = c.req.path.replace('/api/files/', '')
  const key = decodeURIComponent(raw)
  const normalized = path.normalize(key)
  if (!key || key.includes('\0') || normalized.startsWith('..') || normalized !== key) {
    return c.json({ error: 'Invalid file path' }, 400)
  }
  if (!ALLOWED_PREFIXES.some((p) => key.startsWith(p))) {
    return c.json({ error: 'Invalid file path' }, 400)
  }

  try {
    const stream = await storageService.download(key)
    if (!stream) {
      return c.json({ error: 'File not found' }, 404)
    }

    const filename = sanitizeFileName(key.split('/').pop() ?? 'file')
    return new Response(stream as ReadableStream, {
      headers: {
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Type': 'application/octet-stream',
      },
    })
  } catch {
    return c.json({ error: 'File not found' }, 404)
  }
})

export default app
