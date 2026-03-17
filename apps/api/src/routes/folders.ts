import { Hono } from 'hono'
import { folderService } from '../services/folder.service.js'
import { createFolderSchema } from '@agentbuddy/shared'

const app = new Hono()

app.get('/workspaces/:workspaceId/folders', async (c) => {
  const { workspaceId } = c.req.param()
  const parentId = c.req.query('parentId')
  const folders = await folderService.listByParent(
    workspaceId,
    parentId === undefined ? null : parentId === 'null' ? null : parentId,
  )
  return c.json({ success: true, data: folders })
})

app.get('/workspaces/:workspaceId/folders/:folderId', async (c) => {
  const { folderId } = c.req.param()
  const result = await folderService.getWithAncestors(folderId)
  if (!result) {
    return c.json({ success: false, error: 'Folder not found' }, 404)
  }
  return c.json({ success: true, data: result })
})

app.post('/workspaces/:workspaceId/folders', async (c) => {
  const { workspaceId } = c.req.param()
  const body = await c.req.json()
  const parsed = createFolderSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }, 400)
  }
  const folder = await folderService.create({
    name: parsed.data.name,
    workspaceId,
    parentId: parsed.data.parentId,
  })
  return c.json({ success: true, data: folder }, 201)
})

app.delete('/workspaces/:workspaceId/folders/:folderId', async (c) => {
  const { folderId } = c.req.param()
  await folderService.delete(folderId)
  return c.json({ success: true, data: { id: folderId } })
})

export default app
