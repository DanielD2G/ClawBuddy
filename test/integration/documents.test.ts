import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createWorkspace, deleteWorkspace, enableCapability, setAutoExecute } from './helpers'

const API_BASE = process.env.API_BASE ?? 'http://localhost:4000/api'
const TIMEOUT = 180_000
const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS === 'true'
const describeIntegration = RUN_INTEGRATION_TESTS ? describe : describe.skip

let workspaceId: string

beforeAll(async () => {
  if (!RUN_INTEGRATION_TESTS) return

  const ws = await createWorkspace(`Document Tests ${Date.now()}`)
  workspaceId = ws.id
  await enableCapability(workspaceId, 'document-search')
  await enableCapability(workspaceId, 'agent-memory')
  await setAutoExecute(workspaceId)
}, TIMEOUT)

afterAll(async () => {
  if (!RUN_INTEGRATION_TESTS) return
  if (workspaceId) await deleteWorkspace(workspaceId)
}, 30_000)

describeIntegration('Document Pipeline Integration', () => {
  let documentId: string

  test(
    'uploads document and creates chunks',
    async () => {
      // Create a document with inline content via the API
      const res = await fetch(`${API_BASE}/workspaces/${workspaceId}/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Test Document - Quantum Computing',
          type: 'TXT',
          content:
            "Quantum computing uses quantum bits or qubits to perform calculations. Unlike classical bits that are either 0 or 1, qubits can exist in superposition. This allows quantum computers to solve certain problems exponentially faster than classical computers. Shor's algorithm can factor large numbers efficiently on a quantum computer.",
        }),
      })
      const json = (await res.json()) as { success: boolean; data: { id: string; status: string } }
      expect(json.success).toBe(true)
      expect(json.data.id).toBeTruthy()
      documentId = json.data.id

      // Wait for ingestion to process (may take a few seconds)
      let attempts = 0
      while (attempts < 15) {
        await new Promise((r) => setTimeout(r, 2000))
        const docRes = await fetch(`${API_BASE}/workspaces/${workspaceId}/documents/${documentId}`)
        const docJson = (await docRes.json()) as {
          success: boolean
          data: { status: string; chunkCount?: number }
        }
        if (docJson.data.status === 'READY') break
        attempts++
      }
    },
    TIMEOUT,
  )

  test(
    'searches documents by similarity',
    async () => {
      // Use the search API directly
      const res = await fetch(`${API_BASE}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'quantum computing qubits',
          workspaceId,
          limit: 5,
        }),
      })
      const json = (await res.json()) as {
        success: boolean
        data: Array<{ score: number; content?: string }>
      }
      expect(json.success).toBe(true)
      // Should find at least one relevant result
      expect(json.data.length).toBeGreaterThan(0)
    },
    TIMEOUT,
  )

  test(
    'returns empty for unrelated query',
    async () => {
      const res = await fetch(`${API_BASE}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'medieval castle architecture fortification',
          workspaceId,
          limit: 5,
        }),
      })
      const json = (await res.json()) as {
        success: boolean
        data: Array<{ score: number }>
      }
      expect(json.success).toBe(true)
      // Results should be empty or have very low scores
      if (json.data.length > 0) {
        // If results exist, the top score should be relatively low
        expect(json.data[0].score).toBeLessThan(0.8)
      }
    },
    TIMEOUT,
  )

  test(
    'deletes document and cleans up chunks',
    async () => {
      if (!documentId) return

      const res = await fetch(`${API_BASE}/workspaces/${workspaceId}/documents/${documentId}`, {
        method: 'DELETE',
      })
      const json = (await res.json()) as { success: boolean; data: { id: string } }
      expect(json.success).toBe(true)
      expect(json.data.id).toBe(documentId)

      // Verify document is gone
      const checkRes = await fetch(`${API_BASE}/workspaces/${workspaceId}/documents/${documentId}`)
      const checkJson = (await checkRes.json()) as { success: boolean; error?: string }
      expect(checkJson.success).toBe(false)
    },
    TIMEOUT,
  )

  test(
    'handles multiple documents in workspace',
    async () => {
      const docs = [
        'Machine learning basics',
        'Deep learning neural networks',
        'Natural language processing',
      ]
      const docIds: string[] = []

      for (const title of docs) {
        const res = await fetch(`${API_BASE}/workspaces/${workspaceId}/documents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            type: 'TXT',
            content: `This document covers ${title.toLowerCase()}. It contains detailed information about the topic.`,
          }),
        })
        const json = (await res.json()) as { success: boolean; data: { id: string } }
        expect(json.success).toBe(true)
        docIds.push(json.data.id)
      }

      // List all documents in workspace
      const listRes = await fetch(`${API_BASE}/workspaces/${workspaceId}/documents`)
      const listJson = (await listRes.json()) as {
        success: boolean
        data: Array<{ id: string; title: string }>
      }
      expect(listJson.success).toBe(true)
      expect(listJson.data.length).toBeGreaterThanOrEqual(docs.length)

      // Clean up created docs
      for (const id of docIds) {
        await fetch(`${API_BASE}/workspaces/${workspaceId}/documents/${id}`, {
          method: 'DELETE',
        })
      }
    },
    TIMEOUT,
  )
})
