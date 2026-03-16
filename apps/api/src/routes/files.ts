import { Hono } from 'hono'
import { storageService } from '../services/storage.service.js'

const app = new Hono()

app.get('/files/*', async (c) => {
  const key = c.req.path.replace('/api/files/', '')
  if (!key || key.includes('..')) {
    return c.json({ error: 'Invalid file path' }, 400)
  }

  try {
    const stream = await storageService.download(key)
    if (!stream) {
      return c.json({ error: 'File not found' }, 404)
    }

    const filename = key.split('/').pop() ?? 'file'
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
