import { Queue } from 'bullmq'
import { redisConnection } from '../lib/redis.js'

const QUEUE_NAME = 'document-ingestion'

const ingestionQueue = new Queue(QUEUE_NAME, {
  connection: redisConnection,
})

export const ingestionService = {
  async enqueue(documentId: string, fileUrl?: string) {
    await ingestionQueue.add('ingest', { documentId, fileUrl: fileUrl ?? null })
  },
}
