import { Worker, type Job } from 'bullmq'
import { redisConnection } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'
import { storageService } from '../services/storage.service.js'
import { chunkingService } from '../services/chunking.service.js'
import { embeddingService } from '../services/embedding.service.js'
import { searchService } from '../services/search.service.js'
import { CHUNK_SIZE, CHUNK_OVERLAP } from '@clawbuddy/shared'
import { randomUUID } from 'crypto'
import { sanitizeSurrogates } from '../lib/sanitize.js'
import { logger } from '../lib/logger.js'

interface IngestionJobData {
  documentId: string
  fileUrl: string | null
}

const QUEUE_NAME = 'document-ingestion'

const worker = new Worker<IngestionJobData>(
  QUEUE_NAME,
  async (job: Job<IngestionJobData>) => {
    const { documentId, fileUrl } = job.data
    logger.info(`[Ingestion] Processing document ${documentId}`)

    // Update status to PROCESSING
    await prisma.document.update({
      where: { id: documentId },
      data: { status: 'PROCESSING', processingStep: 'downloading', processingPct: 0 },
    })

    try {
      // 1. Get text content — from MinIO or inline document content
      let text: string
      if (fileUrl) {
        const fileStream = await storageService.download(fileUrl)
        const chunksRaw: Buffer[] = []
        for await (const chunk of fileStream as AsyncIterable<string | Uint8Array>) {
          chunksRaw.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk))
        }
        text = Buffer.concat(chunksRaw).toString('utf-8')
      } else {
        // Inline content (e.g. from save_document tool)
        const doc = await prisma.document.findUniqueOrThrow({ where: { id: documentId } })
        text = doc.content ?? ''
      }

      // Strip characters that break Prisma JSON serialization
      text = sanitizeSurrogates(text)

      if (!text.trim()) {
        throw new Error('Empty document content')
      }

      // 2. Split into chunks
      await prisma.document.update({
        where: { id: documentId },
        data: { processingStep: 'chunking', processingPct: 15 },
      })

      const chunks = await chunkingService.splitText(text, {
        chunkSize: CHUNK_SIZE,
        overlap: CHUNK_OVERLAP,
      })

      logger.info(`[Ingestion] Document ${documentId}: ${chunks.length} chunks`)

      // 3. Ensure Qdrant collection exists
      const dimensions = await embeddingService.getEmbeddingDimensions()
      await searchService.ensureCollection(dimensions)

      // 4. Generate embeddings and store
      await prisma.document.update({
        where: { id: documentId },
        data: { processingStep: 'embedding', processingPct: 25 },
      })

      const batchSize = 20
      let totalStored = 0

      // Fetch document once for workspaceId (instead of per-chunk)
      const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } })
      const workspaceId = document.workspaceId

      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize)
        const embeddings = await embeddingService.embedBatch(batch)

        for (let j = 0; j < batch.length; j++) {
          const qdrantId = randomUUID()
          const chunkIndex = i + j

          // Store in Postgres
          const safeContent = sanitizeSurrogates(batch[j])
          const chunk = await prisma.documentChunk.create({
            data: {
              documentId,
              content: safeContent,
              qdrantId,
              chunkIndex,
              metadata: { workspaceId: workspaceId },
            },
          })

          // Store vector in Qdrant — include chunkId and workspaceId for search
          await searchService.upsert(qdrantId, embeddings[j], {
            documentId,
            chunkId: chunk.id,
            chunkIndex,
            workspaceId: workspaceId,
            content: safeContent.slice(0, 200), // preview
          })

          totalStored++
        }

        // Update progress
        const pct = Math.round(25 + (totalStored / chunks.length) * 70)
        await prisma.document.update({
          where: { id: documentId },
          data: { processingStep: 'indexing', processingPct: Math.min(pct, 95) },
        })
      }

      // 5. Update document status to READY
      await prisma.document.update({
        where: { id: documentId },
        data: {
          status: 'READY',
          content: text.slice(0, 10000), // store preview
          chunkCount: totalStored,
          processingStep: null,
          processingPct: 100,
        },
      })

      logger.info(`[Ingestion] Document ${documentId} ready: ${totalStored} chunks indexed`)
    } catch (error) {
      logger.error(`[Ingestion] Failed for document ${documentId}`, error)
      await prisma.document.update({
        where: { id: documentId },
        data: { status: 'FAILED', processingStep: null, processingPct: null },
      })
      throw error
    }
  },
  {
    connection: redisConnection,
    concurrency: 3,
  },
)

worker.on('completed', (job) => {
  logger.info(`[Ingestion] Job ${job.id} completed`)
})

worker.on('failed', (job, err) => {
  logger.error(`[Ingestion] Job ${job?.id} failed`, err)
})

export { worker as ingestionWorker }
