import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import {
  createWorkspace,
  deleteWorkspace,
  enableCapabilityWithConfig,
  setAutoExecute,
  updateWorkspaceSettings,
  sendMessage,
  getMessages,
  approveTool,
} from './helpers'

const TIMEOUT = 180_000
const MASK = '********'
const GH_SECRET = 'ghp_test_secret_for_redaction'
const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS === 'true'
const describeIntegration = RUN_INTEGRATION_TESTS ? describe : describe.skip

let autoWorkspaceId: string
let approvalWorkspaceId: string
let unmaskedAutoWorkspaceId: string
let unmaskedApprovalWorkspaceId: string

beforeAll(async () => {
  if (!RUN_INTEGRATION_TESTS) {
    return
  }

  const autoWs = await createWorkspace(`Secrets Auto ${Date.now()}`)
  autoWorkspaceId = autoWs.id
  await enableCapabilityWithConfig(autoWorkspaceId, 'bash')
  await enableCapabilityWithConfig(autoWorkspaceId, 'gh-cli', { gh_token: GH_SECRET })
  await setAutoExecute(autoWorkspaceId)

  const approvalWs = await createWorkspace(`Secrets Approval ${Date.now()}`)
  approvalWorkspaceId = approvalWs.id
  await enableCapabilityWithConfig(approvalWorkspaceId, 'bash')
  await enableCapabilityWithConfig(approvalWorkspaceId, 'gh-cli', { gh_token: GH_SECRET })

  const unmaskedAutoWs = await createWorkspace(`Secrets Unmasked Auto ${Date.now()}`)
  unmaskedAutoWorkspaceId = unmaskedAutoWs.id
  await updateWorkspaceSettings(unmaskedAutoWorkspaceId, { secretRedactionEnabled: false })
  await enableCapabilityWithConfig(unmaskedAutoWorkspaceId, 'bash')
  await enableCapabilityWithConfig(unmaskedAutoWorkspaceId, 'gh-cli', { gh_token: GH_SECRET })
  await setAutoExecute(unmaskedAutoWorkspaceId)

  const unmaskedApprovalWs = await createWorkspace(`Secrets Unmasked Approval ${Date.now()}`)
  unmaskedApprovalWorkspaceId = unmaskedApprovalWs.id
  await updateWorkspaceSettings(unmaskedApprovalWorkspaceId, { secretRedactionEnabled: false })
  await enableCapabilityWithConfig(unmaskedApprovalWorkspaceId, 'bash')
  await enableCapabilityWithConfig(unmaskedApprovalWorkspaceId, 'gh-cli', { gh_token: GH_SECRET })
}, TIMEOUT)

afterAll(async () => {
  if (!RUN_INTEGRATION_TESTS) {
    return
  }

  if (autoWorkspaceId) await deleteWorkspace(autoWorkspaceId)
  if (approvalWorkspaceId) await deleteWorkspace(approvalWorkspaceId)
  if (unmaskedAutoWorkspaceId) await deleteWorkspace(unmaskedAutoWorkspaceId)
  if (unmaskedApprovalWorkspaceId) await deleteWorkspace(unmaskedApprovalWorkspaceId)
}, 30_000)

describeIntegration('Secret Redaction', () => {
  test(
    'redacts secret values from SSE and persisted tool executions',
    async () => {
      const result = await sendMessage('/bash Run `echo $GH_TOKEN`', autoWorkspaceId)
      const bashResult = result.toolExecutions.find((tool) => tool.toolName === 'run_bash')

      expect(bashResult).toBeTruthy()
      expect(bashResult?.output).toContain(MASK)
      expect(bashResult?.output).not.toContain(GH_SECRET)

      const history = await getMessages(result.sessionId)
      const serialized = JSON.stringify(history)
      expect(serialized).toContain(MASK)
      expect(serialized).not.toContain(GH_SECRET)
    },
    TIMEOUT,
  )

  test(
    'stores pasted configured secrets in redacted form before the model sees them',
    async () => {
      const result = await sendMessage(
        `The GitHub token is ${GH_SECRET}. Just acknowledge receipt.`,
        autoWorkspaceId,
      )
      const history = await getMessages(result.sessionId)
      const serialized = JSON.stringify(history)

      expect(serialized).toContain(MASK)
      expect(serialized).not.toContain(GH_SECRET)
      expect(history.messages.some((message) => message.content.includes(MASK))).toBe(true)
    },
    TIMEOUT,
  )

  test(
    'keeps approval payloads redacted and still resumes execution successfully',
    async () => {
      const initial = await sendMessage('/bash Run `echo $GH_TOKEN`', approvalWorkspaceId)
      const approvalEvent = initial.events.find((event) => event.event === 'approval_required')

      expect(approvalEvent).toBeTruthy()
      expect(JSON.stringify(approvalEvent?.data ?? {})).not.toContain(GH_SECRET)
      expect(JSON.stringify(approvalEvent?.data ?? {})).toContain('GH_TOKEN')

      const approvalId = approvalEvent?.data.approvalId as string
      const resumed = await approveTool(initial.sessionId, approvalId, 'approved')

      expect('events' in resumed).toBe(true)
      if (!('events' in resumed)) return

      const serializedEvents = JSON.stringify(resumed.events)
      expect(serializedEvents).toContain(MASK)
      expect(serializedEvents).not.toContain(GH_SECRET)

      const history = await getMessages(initial.sessionId)
      const serializedHistory = JSON.stringify(history)
      expect(serializedHistory).toContain(MASK)
      expect(serializedHistory).not.toContain(GH_SECRET)
    },
    TIMEOUT,
  )

  test(
    'exposes secret values again when workspace redaction is disabled',
    async () => {
      const result = await sendMessage('/bash Run `echo $GH_TOKEN`', unmaskedAutoWorkspaceId)
      const bashResult = result.toolExecutions.find((tool) => tool.toolName === 'run_bash')

      expect(bashResult).toBeTruthy()
      expect(bashResult?.output).toContain(GH_SECRET)
      expect(bashResult?.output).not.toContain(MASK)

      const history = await getMessages(result.sessionId)
      const serialized = JSON.stringify(history)
      expect(serialized).toContain(GH_SECRET)
      expect(serialized).not.toContain(MASK)
    },
    TIMEOUT,
  )

  test(
    'shows raw approval payloads and persisted values when workspace redaction is disabled',
    async () => {
      const initial = await sendMessage('/bash Run `echo $GH_TOKEN`', unmaskedApprovalWorkspaceId)
      const approvalEvent = initial.events.find((event) => event.event === 'approval_required')

      expect(approvalEvent).toBeTruthy()
      expect(JSON.stringify(approvalEvent?.data ?? {})).toContain(GH_SECRET)
      expect(JSON.stringify(approvalEvent?.data ?? {})).not.toContain(MASK)

      const approvalId = approvalEvent?.data.approvalId as string
      const resumed = await approveTool(initial.sessionId, approvalId, 'approved')

      expect('events' in resumed).toBe(true)
      if (!('events' in resumed)) return

      const serializedEvents = JSON.stringify(resumed.events)
      expect(serializedEvents).toContain(GH_SECRET)
      expect(serializedEvents).not.toContain(MASK)

      const history = await getMessages(initial.sessionId)
      const serializedHistory = JSON.stringify(history)
      expect(serializedHistory).toContain(GH_SECRET)
      expect(serializedHistory).not.toContain(MASK)
    },
    TIMEOUT,
  )
})
