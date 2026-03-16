import { Hono } from 'hono'
import { embeddingService } from '../services/embedding.service.js'
import { searchService } from '../services/search.service.js'

const app = new Hono()

app.post('/search', async (c) => {
  try {
    const body = await c.req.json()
    const { query, workspaceId, limit } = body

    if (!query || !workspaceId) {
      return c.json({ success: false, error: 'query and workspaceId are required' }, 400)
    }

    const queryVector = await embeddingService.embed(query)
    const results = await searchService.search(queryVector, {
      limit: limit ?? 10,
      workspaceId,
    })

    return c.json({ success: true, data: results })
  } catch (error) {
    return c.json({ success: false, error: 'Search failed' }, 500)
  }
})

export default app
