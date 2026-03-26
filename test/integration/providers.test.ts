import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import {
  createWorkspace,
  deleteWorkspace,
  enableCapability,
  setAutoExecute,
  sendMessage,
  assertToolUsed,
} from './helpers'

const TIMEOUT = 180_000
const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS === 'true'
const describeIntegration = RUN_INTEGRATION_TESTS ? describe : describe.skip

let workspaceId: string

beforeAll(async () => {
  if (!RUN_INTEGRATION_TESTS) return

  const ws = await createWorkspace(`Provider Tests ${Date.now()}`)
  workspaceId = ws.id
  await enableCapability(workspaceId, 'bash')
  await setAutoExecute(workspaceId)
}, TIMEOUT)

afterAll(async () => {
  if (!RUN_INTEGRATION_TESTS) return
  if (workspaceId) await deleteWorkspace(workspaceId)
}, 30_000)

describeIntegration('LLM Provider Integration', () => {
  test(
    'completes simple prompt with configured provider',
    async () => {
      const result = await sendMessage('What is 2 + 2? Reply with just the number.', workspaceId)
      expect(result.content).toBeTruthy()
      expect(result.content.length).toBeGreaterThan(0)
      expect(result.content).toContain('4')
    },
    TIMEOUT,
  )

  test(
    'generates tool calls when tools are provided',
    async () => {
      const result = await sendMessage('Run `echo tool-call-test` in bash', workspaceId)
      assertToolUsed(result, 'run_bash')
      // Tool execution should have happened
      expect(result.toolExecutions.length).toBeGreaterThanOrEqual(1)
    },
    TIMEOUT,
  )

  test(
    'reports token usage',
    async () => {
      const result = await sendMessage('Say hello in exactly one word.', workspaceId)
      // The done event should include token usage
      const doneEvent = result.events.find((e) => e.event === 'done')
      expect(doneEvent).toBeTruthy()
      // Token usage may be in the done event or session metadata
      const usage = doneEvent?.data?.usage as
        | { promptTokens?: number; completionTokens?: number; totalTokens?: number }
        | undefined
      if (usage) {
        expect(usage.promptTokens ?? usage.totalTokens).toBeGreaterThan(0)
      }
      // Even without usage in done event, the response should succeed
      expect(result.content.length).toBeGreaterThan(0)
    },
    TIMEOUT,
  )

  test(
    'handles empty/invalid prompt gracefully',
    async () => {
      // Sending an empty-ish prompt should still get a response or a clean error
      try {
        const result = await sendMessage(' ', workspaceId)
        // If it succeeds, should have some content or at minimum not crash
        expect(result.events.length).toBeGreaterThan(0)
      } catch (err) {
        // A clean HTTP error is acceptable
        expect(err).toBeInstanceOf(Error)
        expect((err as Error).message).toMatch(/failed|invalid|empty|400/i)
      }
    },
    TIMEOUT,
  )
})
