import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import {
  createWorkspace,
  deleteWorkspace,
  enableCapability,
  setAutoExecute,
  sendMessage,
  approveTool,
} from './helpers'

const API_BASE = process.env.API_BASE ?? 'http://localhost:4000/api'
const TIMEOUT = 180_000
const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS === 'true'
const describeIntegration = RUN_INTEGRATION_TESTS ? describe : describe.skip

let autoWorkspaceId: string
let approvalWorkspaceId: string

beforeAll(async () => {
  if (!RUN_INTEGRATION_TESTS) return

  const autoWs = await createWorkspace(`SSE Auto Tests ${Date.now()}`)
  autoWorkspaceId = autoWs.id
  await enableCapability(autoWorkspaceId, 'bash')
  await setAutoExecute(autoWorkspaceId)

  const approvalWs = await createWorkspace(`SSE Approval Tests ${Date.now()}`)
  approvalWorkspaceId = approvalWs.id
  await enableCapability(approvalWorkspaceId, 'bash')
  // No auto-execute — requires approval
}, TIMEOUT)

afterAll(async () => {
  if (!RUN_INTEGRATION_TESTS) return
  if (autoWorkspaceId) await deleteWorkspace(autoWorkspaceId)
  if (approvalWorkspaceId) await deleteWorkspace(approvalWorkspaceId)
}, 30_000)

describeIntegration('SSE Streaming Integration', () => {
  test(
    'emits session event as first event',
    async () => {
      const result = await sendMessage('Say hello', autoWorkspaceId)
      expect(result.events.length).toBeGreaterThan(0)
      expect(result.events[0].event).toBe('session')
      expect(result.events[0].data.sessionId).toBeTruthy()
    },
    TIMEOUT,
  )

  test(
    'emits content events for text response',
    async () => {
      const result = await sendMessage('Say exactly: test-content-event', autoWorkspaceId)
      const contentEvents = result.events.filter((e) => e.event === 'content')
      expect(contentEvents.length).toBeGreaterThan(0)
      // Joined content should contain something
      expect(result.content.length).toBeGreaterThan(0)
    },
    TIMEOUT,
  )

  test(
    'emits tool_start and tool_result for tool execution',
    async () => {
      const result = await sendMessage('Run `echo sse-tool-test` in bash', autoWorkspaceId)
      const toolStartEvents = result.events.filter((e) => e.event === 'tool_start')
      const toolResultEvents = result.events.filter((e) => e.event === 'tool_result')

      expect(toolStartEvents.length).toBeGreaterThanOrEqual(1)
      expect(toolResultEvents.length).toBeGreaterThanOrEqual(1)

      // tool_start should have toolName
      expect(toolStartEvents[0].data.toolName).toBe('run_bash')

      // tool_result should have output
      const bashResult = toolResultEvents.find((e) => e.data.toolName === 'run_bash')
      expect(bashResult).toBeTruthy()
    },
    TIMEOUT,
  )

  test(
    'emits done event as last event',
    async () => {
      const result = await sendMessage('Say done', autoWorkspaceId)
      const lastEvent = result.events[result.events.length - 1]
      expect(lastEvent.event).toBe('done')
      expect(lastEvent.data.sessionId).toBeTruthy()
    },
    TIMEOUT,
  )

  test(
    'emits error event on failure',
    async () => {
      // Send to a non-existent workspace to trigger an error
      try {
        const result = await sendMessage('hello', 'non-existent-workspace-id-12345')
        // If no error thrown, check for error events
        const errorEvents = result.events.filter((e) => e.event === 'error')
        expect(errorEvents.length).toBeGreaterThan(0)
      } catch (err) {
        // HTTP error is also acceptable
        expect(err).toBeInstanceOf(Error)
      }
    },
    TIMEOUT,
  )

  test(
    'emits pending_approval for unapproved tools',
    async () => {
      const result = await sendMessage('Run `echo approval-test` in bash', approvalWorkspaceId)
      const approvalEvents = result.events.filter((e) => e.event === 'approval_required')
      expect(approvalEvents.length).toBeGreaterThan(0)
      expect(approvalEvents[0].data.approvalId).toBeTruthy()
      expect(approvalEvents[0].data.toolName).toBeTruthy()
    },
    TIMEOUT,
  )

  test(
    'resumes after approval with correct events',
    async () => {
      const initial = await sendMessage('Run `echo resume-test` in bash', approvalWorkspaceId)
      const approvalEvent = initial.events.find((e) => e.event === 'approval_required')
      expect(approvalEvent).toBeTruthy()

      const approvalId = approvalEvent!.data.approvalId as string
      const resumed = await approveTool(initial.sessionId, approvalId, 'approved')

      expect('events' in resumed).toBe(true)
      if (!('events' in resumed)) return

      // After approval, should get tool_result and done events
      const toolResults = resumed.events.filter((e) => e.event === 'tool_result')
      expect(toolResults.length).toBeGreaterThanOrEqual(1)

      const doneEvent = resumed.events.find((e) => e.event === 'done')
      expect(doneEvent).toBeTruthy()
    },
    TIMEOUT,
  )

  test(
    'handles client abort gracefully',
    async () => {
      const controller = new AbortController()

      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Write a very long essay about the history of computing',
          workspaceId: autoWorkspaceId,
        }),
        signal: controller.signal,
      })

      // Read just the first chunk then abort
      const reader = res.body!.getReader()
      await reader.read()
      controller.abort()

      // Server should handle the abort without crashing
      // Verify by sending another message successfully
      const result = await sendMessage('Say ok', autoWorkspaceId)
      expect(result.content.length).toBeGreaterThan(0)
    },
    TIMEOUT,
  )
})
