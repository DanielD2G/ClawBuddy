import { Hono } from 'hono'
import { folderService } from '../services/folder.service.js'

const app = new Hono()

app.get('/workspaces/:workspaceId/folders', async (c) => {
  try {
    const { workspaceId } = c.req.param()
    const parentId = c.req.query('parentId')
    const folders = await folderService.listByParent(
      workspaceId,
      parentId === undefined ? null : parentId === 'null' ? null : parentId,
    )
    return c.json({ success: true, data: folders })
  } catch (error) {
    return c.json({ success: false, error: 'Failed to list folders' }, 500)
  }
})

app.get('/workspaces/:workspaceId/folders/:folderId', async (c) => {
  try {
    const { folderId } = c.req.param()
    const result = await folderService.getWithAncestors(folderId)
    if (!result) {
      return c.json({ success: false, error: 'Folder not found' }, 404)
    }
    return c.json({ success: true, data: result })
  } catch (error) {
    return c.json({ success: false, error: 'Failed to get folder' }, 500)
  }
})

app.post('/workspaces/:workspaceId/folders', async (c) => {
  try {
    const { workspaceId } = c.req.param()
    const body = await c.req.json()
    const folder = await folderService.create({
      name: body.name,
      workspaceId,
      parentId: body.parentId,
    })
    return c.json({ success: true, data: folder }, 201)
  } catch (error) {
    return c.json({ success: false, error: 'Failed to create folder' }, 500)
  }
})

app.delete('/workspaces/:workspaceId/folders/:folderId', async (c) => {
  try {
    const { folderId } = c.req.param()
    await folderService.delete(folderId)
    return c.json({ success: true, data: { id: folderId } })
  } catch (error) {
    return c.json({ success: false, error: 'Failed to delete folder' }, 500)
  }
})

export default app
