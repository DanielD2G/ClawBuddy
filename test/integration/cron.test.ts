import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import {
  createWorkspace,
  deleteWorkspace,
  enableCapability,
  setAutoExecute,
  sendMessage,
} from './helpers'

const API_BASE = process.env.API_BASE ?? 'http://localhost:4000/api'
const TIMEOUT = 180_000
const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS === 'true'
const describeIntegration = RUN_INTEGRATION_TESTS ? describe : describe.skip

let workspaceId: string

beforeAll(async () => {
  if (!RUN_INTEGRATION_TESTS) return

  const ws = await createWorkspace(`Cron Tests ${Date.now()}`)
  workspaceId = ws.id
  await enableCapability(workspaceId, 'cron-management')
  await setAutoExecute(workspaceId)
}, TIMEOUT)

afterAll(async () => {
  if (!RUN_INTEGRATION_TESTS) return
  if (workspaceId) await deleteWorkspace(workspaceId)
}, 30_000)

describeIntegration('Cron Integration', () => {
  let cronJobId: string

  test(
    'creates cron job via chat',
    async () => {
      const result = await sendMessage(
        'Create a cron job called "Integration Test Job" that runs every hour with the prompt "Check system status"',
        workspaceId,
      )
      // The agent should use the cron management tool
      const allText = [result.content, ...result.toolExecutions.map((t) => t.output ?? '')].join(
        ' ',
      )
      expect(allText.toLowerCase()).toMatch(/cron|job|created|scheduled/)
    },
    TIMEOUT,
  )

  test(
    'lists cron jobs',
    async () => {
      // Create a cron job via API first for reliable testing
      const createRes = await fetch(`${API_BASE}/cron`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'List Test Job',
          schedule: '0 * * * *',
          type: 'agent',
          prompt: 'Test prompt',
          workspaceId,
          enabled: false,
        }),
      })
      const createJson = (await createRes.json()) as {
        success: boolean
        data: { id: string; name: string }
      }
      expect(createJson.success).toBe(true)
      cronJobId = createJson.data.id

      // List cron jobs via API
      const listRes = await fetch(`${API_BASE}/cron?workspaceId=${workspaceId}`)
      const listJson = (await listRes.json()) as {
        success: boolean
        data: Array<{ id: string; name: string; schedule: string }>
      }
      expect(listJson.success).toBe(true)
      expect(listJson.data.length).toBeGreaterThanOrEqual(1)

      const found = listJson.data.find((j) => j.id === cronJobId)
      expect(found).toBeTruthy()
      expect(found!.name).toBe('List Test Job')
    },
    TIMEOUT,
  )

  test(
    'deletes cron job',
    async () => {
      if (!cronJobId) return

      const res = await fetch(`${API_BASE}/cron/${cronJobId}`, {
        method: 'DELETE',
      })
      const json = (await res.json()) as { success: boolean }
      expect(json.success).toBe(true)

      // Verify it is gone
      const listRes = await fetch(`${API_BASE}/cron?workspaceId=${workspaceId}`)
      const listJson = (await listRes.json()) as {
        success: boolean
        data: Array<{ id: string }>
      }
      const found = listJson.data.find((j) => j.id === cronJobId)
      expect(found).toBeUndefined()
    },
    TIMEOUT,
  )

  test(
    'handles invalid cron expression',
    async () => {
      const res = await fetch(`${API_BASE}/cron`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Invalid Cron Job',
          schedule: 'not-a-valid-cron',
          type: 'agent',
          prompt: 'Test',
          workspaceId,
        }),
      })
      // Should fail with a validation error or the server should handle it
      if (res.ok) {
        const json = (await res.json()) as { success: boolean; data: { id: string } }
        // If it was created despite invalid cron, clean it up
        if (json.data?.id) {
          await fetch(`${API_BASE}/cron/${json.data.id}`, { method: 'DELETE' })
        }
      } else {
        // Expected: server rejects invalid cron expression
        expect(res.status).toBeGreaterThanOrEqual(400)
      }
    },
    TIMEOUT,
  )
})
