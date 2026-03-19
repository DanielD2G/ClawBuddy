/**
 * Backfill Qdrant points with workspaceId and chunkId from Postgres.
 * Run: bun apps/api/src/scripts/backfill-qdrant.ts
 */
import { prisma } from '../lib/prisma.js'
import { qdrant } from '../lib/qdrant.js'
import { QDRANT_COLLECTION_NAME } from '@clawbuddy/shared'

async function backfill() {
  const chunks = await prisma.documentChunk.findMany({
    include: { document: { select: { workspaceId: true } } },
  })

  console.log(`Found ${chunks.length} chunks to backfill`)

  let updated = 0
  for (const chunk of chunks) {
    if (!chunk.qdrantId) continue
    try {
      await qdrant.setPayload(QDRANT_COLLECTION_NAME, {
        points: [chunk.qdrantId],
        payload: {
          chunkId: chunk.id,
          workspaceId: chunk.document.workspaceId,
        },
      })
      updated++
    } catch (err) {
      console.error(`Failed to update point ${chunk.qdrantId}:`, err)
    }
  }

  console.log(`Backfilled ${updated}/${chunks.length} Qdrant points`)
  process.exit(0)
}

backfill().catch((err) => {
  console.error('Backfill failed:', err)
  process.exit(1)
})
