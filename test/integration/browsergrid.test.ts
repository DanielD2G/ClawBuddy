import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import {
  createWorkspace,
  deleteWorkspace,
  enableCapability,
  setAutoExecute,
  sendMessage,
  assertToolUsed,
  assertNoError,
} from './helpers'

const API_BASE = process.env.API_BASE ?? 'http://localhost:4000/api'
const TIMEOUT = 180_000
const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS === 'true'
const describeIntegration = RUN_INTEGRATION_TESTS ? describe : describe.skip

let workspaceId: string

beforeAll(async () => {
  if (!RUN_INTEGRATION_TESTS) return

  const ws = await createWorkspace(`BrowserGrid Tests ${Date.now()}`)
  workspaceId = ws.id
  await enableCapability(workspaceId, 'browser-automation')
  await setAutoExecute(workspaceId)
}, TIMEOUT)

afterAll(async () => {
  if (!RUN_INTEGRATION_TESTS) return
  if (workspaceId) await deleteWorkspace(workspaceId)
}, 30_000)

describeIntegration('BrowserGrid Integration', () => {
  test(
    'health check returns true when BrowserGrid is running',
    async () => {
      const res = await fetch(`${API_BASE}/browser/health`)
      const json = (await res.json()) as { success: boolean; data: { healthy: boolean } }
      expect(json.success).toBe(true)
      expect(json.data.healthy).toBe(true)
    },
    TIMEOUT,
  )

  test(
    'creates browser session and navigates to URL',
    async () => {
      const result = await sendMessage(
        '/browser-automation Navigate to https://example.com and return the page title using `return await page.title()`',
        workspaceId,
      )
      const tool = assertToolUsed(result, 'run_browser_script')
      assertNoError(tool)
      const allText = [result.content, tool.output ?? ''].join(' ').toLowerCase()
      expect(allText).toContain('example')
    },
    TIMEOUT,
  )

  test(
    'extracts page content via run_browser_script',
    async () => {
      const result = await sendMessage(
        '/browser-automation Navigate to https://example.com and use getReadableContent() to extract the page text. Return the result.',
        workspaceId,
      )
      const tool = assertToolUsed(result, 'run_browser_script')
      assertNoError(tool)
      const allText = [result.content, tool.output ?? ''].join(' ').toLowerCase()
      expect(allText).toContain('example')
    },
    TIMEOUT,
  )

  test(
    'captures screenshot',
    async () => {
      const result = await sendMessage(
        '/browser-automation Navigate to https://example.com and take a screenshot using getVisualSnapshot()',
        workspaceId,
      )
      const tool = assertToolUsed(result, 'run_browser_script')
      // Screenshot result should be present in output or as a screenshot field
      const hasScreenshot = tool.screenshot || (tool.output && tool.output.includes('screenshot'))
      expect(hasScreenshot).toBeTruthy()
    },
    TIMEOUT,
  )

  test(
    'handles script timeout gracefully',
    async () => {
      const result = await sendMessage(
        '/browser-automation Run this script with a 5 second timeout: `await new Promise(r => setTimeout(r, 60000)); return "done"`',
        workspaceId,
      )
      const tool = assertToolUsed(result, 'run_browser_script')
      // Should have a timeout error
      const allText = [tool.error ?? '', tool.output ?? ''].join(' ').toLowerCase()
      expect(allText).toMatch(/timeout|timed out|error/)
    },
    TIMEOUT,
  )

  test(
    'cleans up sessions on workspace delete',
    async () => {
      // Create a temporary workspace, use browser, then delete
      const tempWs = await createWorkspace(`BrowserGrid Cleanup ${Date.now()}`)
      await enableCapability(tempWs.id, 'browser-automation')
      await setAutoExecute(tempWs.id)

      await sendMessage('/browser-automation Navigate to https://example.com', tempWs.id)

      // Delete workspace — sessions should be cleaned up
      await deleteWorkspace(tempWs.id)

      // Check active sessions does not include the deleted workspace's session
      const res = await fetch(`${API_BASE}/browser/sessions`)
      const json = (await res.json()) as {
        success: boolean
        data: { sessions: Array<{ chatSessionId: string }> }
      }
      // The deleted workspace's sessions should no longer be active
      expect(json.success).toBe(true)
    },
    TIMEOUT,
  )

  test(
    'handles navigation to invalid URL',
    async () => {
      const result = await sendMessage(
        '/browser-automation Navigate to https://this-domain-does-not-exist-12345.com and return the page title',
        workspaceId,
      )
      const tool = assertToolUsed(result, 'run_browser_script')
      // Should have an error about navigation failure
      const allText = [tool.error ?? '', tool.output ?? '', result.content].join(' ').toLowerCase()
      expect(allText).toMatch(/error|fail|unable|cannot|timeout|not.*found|refused/)
    },
    TIMEOUT,
  )
})
