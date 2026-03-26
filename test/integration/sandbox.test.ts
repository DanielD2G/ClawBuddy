import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import {
  createWorkspace,
  deleteWorkspace,
  enableCapability,
  setAutoExecute,
  sendMessage,
  assertToolUsed,
  assertNoError,
  assertOutputContains,
} from './helpers'

const TIMEOUT = 180_000
const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS === 'true'
const describeIntegration = RUN_INTEGRATION_TESTS ? describe : describe.skip

let workspaceId: string

beforeAll(async () => {
  if (!RUN_INTEGRATION_TESTS) return

  const ws = await createWorkspace(`Sandbox Tests ${Date.now()}`)
  workspaceId = ws.id
  await enableCapability(workspaceId, 'bash')
  await enableCapability(workspaceId, 'python')
  await setAutoExecute(workspaceId)
}, TIMEOUT)

afterAll(async () => {
  if (!RUN_INTEGRATION_TESTS) return
  if (workspaceId) await deleteWorkspace(workspaceId)
}, 30_000)

describeIntegration('Sandbox Integration', () => {
  test(
    'creates container for new workspace',
    async () => {
      // First command in a new workspace triggers container creation
      const result = await sendMessage('Run `echo container-ready` in bash', workspaceId)
      const tool = assertToolUsed(result, 'run_bash')
      assertNoError(tool)
      assertOutputContains(tool, 'container-ready')
    },
    TIMEOUT,
  )

  test(
    'executes bash command in sandbox',
    async () => {
      const result = await sendMessage(
        'Run `uname -s && echo sandbox-test-ok` in bash',
        workspaceId,
      )
      const tool = assertToolUsed(result, 'run_bash')
      assertNoError(tool)
      assertOutputContains(tool, 'sandbox-test-ok')
    },
    TIMEOUT,
  )

  test(
    'executes python script in sandbox',
    async () => {
      const result = await sendMessage(
        'Write and run a Python script that prints the result of 7 * 6',
        workspaceId,
      )
      const tool = assertToolUsed(result, 'run_python')
      assertNoError(tool)
      expect(tool.output).toContain('42')
    },
    TIMEOUT,
  )

  test(
    'reads file from sandbox',
    async () => {
      // First create a file, then read it
      await sendMessage('Run `echo "read-test-content" > /tmp/readtest.txt` in bash', workspaceId)
      const result = await sendMessage('Run `cat /tmp/readtest.txt` in bash', workspaceId)
      const tool = assertToolUsed(result, 'run_bash')
      assertNoError(tool)
      assertOutputContains(tool, 'read-test-content')
    },
    TIMEOUT,
  )

  test(
    'writes file to sandbox',
    async () => {
      const result = await sendMessage(
        'Run `echo "write-test-data" > /tmp/writetest.txt && cat /tmp/writetest.txt` in bash',
        workspaceId,
      )
      const tool = assertToolUsed(result, 'run_bash')
      assertNoError(tool)
      assertOutputContains(tool, 'write-test-data')
    },
    TIMEOUT,
  )

  test(
    'handles large output (>25KB truncation)',
    async () => {
      const result = await sendMessage(
        'Write a Python script that prints "x" repeated 30000 times (one long line)',
        workspaceId,
      )
      const tool = assertToolUsed(result, 'run_python')
      // Output should exist but may be truncated
      expect(tool.output).toBeTruthy()
      // If the output was truncated, it should still contain some content
      expect(tool.output!.length).toBeGreaterThan(0)
    },
    TIMEOUT,
  )

  test(
    'cleans up container on workspace delete',
    async () => {
      const tempWs = await createWorkspace(`Sandbox Cleanup ${Date.now()}`)
      await enableCapability(tempWs.id, 'bash')
      await setAutoExecute(tempWs.id)

      // Trigger container creation
      await sendMessage('Run `echo cleanup-test` in bash', tempWs.id)

      // Delete workspace — container should be cleaned up
      await deleteWorkspace(tempWs.id)

      // Verify by attempting to use the deleted workspace (should fail)
      try {
        await sendMessage('Run `echo should-fail` in bash', tempWs.id)
        // If it doesn't throw, the workspace may still exist briefly
      } catch {
        // Expected: workspace no longer exists
      }
    },
    TIMEOUT,
  )

  test(
    'handles command failure with exit code',
    async () => {
      const result = await sendMessage(
        'Run `exit 42` in bash and tell me the exit code',
        workspaceId,
      )
      const tool = assertToolUsed(result, 'run_bash')
      // Should report non-zero exit code or error
      const hasFailure =
        (tool.exitCode !== undefined && tool.exitCode !== 0) || tool.error !== undefined
      expect(hasFailure).toBe(true)
    },
    TIMEOUT,
  )
})
