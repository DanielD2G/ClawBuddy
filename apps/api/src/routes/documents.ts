import { Hono } from 'hono'
import { prisma } from '../lib/prisma.js'
import { storageService } from '../services/storage.service.js'
import { ingestionService } from '../services/ingestion.service.js'
import { createDocumentSchema } from '@agentbuddy/shared'
import { sanitizeFileName } from '../lib/sanitize.js'
import { validateBody } from '../lib/validate.js'

const app = new Hono()

// All documents
app.get('/documents', async (c) => {
  const documents = await prisma.document.findMany({
    include: { workspace: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return c.json({ success: true, data: documents })
})

app.get('/workspaces/:workspaceId/documents', async (c) => {
  const { workspaceId } = c.req.param()
  const folderIdParam = c.req.query('folderId')

  const where: { workspaceId: string; folderId?: string | null } = { workspaceId }
  if (folderIdParam !== undefined) {
    where.folderId = folderIdParam === 'null' ? null : folderIdParam
  }

  const documents = await prisma.document.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  })
  return c.json({ success: true, data: documents })
})

app.post('/workspaces/:workspaceId/documents', async (c) => {
  const { workspaceId } = c.req.param()
  const contentType = c.req.header('content-type') ?? ''

  if (contentType.includes('multipart/form-data')) {
    const formData = await c.req.formData()
    const file = formData.get('file') as File | null
    const folderId = (formData.get('folderId') as string | null) || null

    if (!file) {
      return c.json({ success: false, error: 'No file provided' }, 400)
    }

    const ext = file.name.split('.').pop()?.toUpperCase() ?? 'TXT'
    const typeMap: Record<string, string> = {
      PDF: 'PDF',
      DOCX: 'DOCX',
      MD: 'MARKDOWN',
      TXT: 'TXT',
      HTML: 'HTML',
    }
    const docType = typeMap[ext] ?? 'TXT'

    const key = `documents/${workspaceId}/${Date.now()}-${sanitizeFileName(file.name)}`
    const buffer = Buffer.from(await file.arrayBuffer())
    await storageService.upload(key, buffer, file.type)

    const document = await prisma.document.create({
      data: {
        title: file.name,
        workspaceId,
        type: docType,
        status: 'PENDING',
        fileUrl: key,
        folderId,
      },
    })

    await ingestionService.enqueue(document.id, key)

    return c.json({ success: true, data: document }, 201)
  }

  // JSON body — create document with inline content
  const body = await c.req.json()
  const data = validateBody(createDocumentSchema, body)
  const document = await prisma.document.create({
    data: {
      title: data.title,
      workspaceId,
      type: data.type ?? 'TXT',
      status: 'READY',
      content: data.content ?? null,
      folderId: data.folderId ?? null,
    },
  })

  return c.json({ success: true, data: document }, 201)
})

app.get('/workspaces/:workspaceId/documents/:docId', async (c) => {
  const { docId } = c.req.param()
  const document = await prisma.document.findUnique({ where: { id: docId } })
  if (!document) {
    return c.json({ success: false, error: 'Document not found' }, 404)
  }
  return c.json({ success: true, data: document })
})

app.patch('/workspaces/:workspaceId/documents/:docId', async (c) => {
  const { docId } = c.req.param()
  const body = await c.req.json()
  const document = await prisma.document.update({
    where: { id: docId },
    data: { folderId: body.folderId ?? null },
  })
  return c.json({ success: true, data: document })
})

app.post('/workspaces/:workspaceId/documents/:docId/reingest', async (c) => {
  const { docId } = c.req.param()
  const document = await prisma.document.findUnique({ where: { id: docId } })
  if (!document) {
    return c.json({ success: false, error: 'Document not found' }, 404)
  }

  // Delete existing chunks so they get recreated
  await prisma.documentChunk.deleteMany({ where: { documentId: docId } })

  // Reset status
  await prisma.document.update({
    where: { id: docId },
    data: { status: 'PENDING', processingStep: null, processingPct: 0, chunkCount: 0 },
  })

  await ingestionService.enqueue(docId, document.fileUrl ?? undefined)

  return c.json({ success: true })
})

app.delete('/workspaces/:workspaceId/documents/:docId', async (c) => {
  const { docId } = c.req.param()
  await prisma.document.delete({ where: { id: docId } })
  return c.json({ success: true, data: { id: docId } })
})

export default app
