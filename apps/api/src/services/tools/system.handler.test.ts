import { describe, expect, test, vi, beforeEach } from 'vitest'
import { createMockPrisma, type MockPrisma } from '@test/factories/prisma'

// ── Mocks ───────────────────────────────────────────────────────────────

let mockPrisma: MockPrisma

vi.mock('../../lib/prisma.js', () => ({
  get prisma() {
    return mockPrisma
  },
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../cron.service.js', () => ({
  cronService: {
    create: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('../tool-discovery.service.js', () => ({
  toolDiscoveryService: {
    search: vi.fn(),
    listAvailable: vi.fn(),
  },
}))

vi.mock('../sub-agent.service.js', () => ({
  subAgentService: {
    runSubAgent: vi.fn(),
  },
}))

vi.mock('../sub-agent-roles.js', () => ({
  SUB_AGENT_ROLES: {
    explore: { name: 'Explorer' },
    analyze: { name: 'Analyzer' },
    execute: { name: 'Executor' },
  },
}))

vi.mock('../secret-redaction.service.js', () => ({
  secretRedactionService: {
    buildSecretInventory: vi.fn().mockResolvedValue({
      workspaceId: 'ws-1',
      enabled: true,
      secretValues: [],
      secretPattern: null,
      aliases: [],
      references: [],
    }),
  },
}))

vi.mock('../browser.service.js', () => ({
  browserService: {
    closeSession: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../../constants.js', () => ({
  ALWAYS_ON_CAPABILITY_SLUGS: ['core-agent'],
  DELEGATION_ONLY_TOOLS: new Set(['run_browser_script']),
}))

import {
  executeCreateCron,
  executeListCrons,
  executeDeleteCron,
  executeDiscoverTools,
  executeDelegateTask,
} from './system.handler.js'
import { cronService } from '../cron.service.js'
import { toolDiscoveryService } from '../tool-discovery.service.js'
import { subAgentService } from '../sub-agent.service.js'
import { browserService } from '../browser.service.js'
import type { ExecutionContext } from './handler-utils.js'

const baseContext: ExecutionContext = {
  workspaceId: 'ws-1',
  chatSessionId: 'session-1',
}

describe('executeCreateCron', () => {
  beforeEach(() => {
    mockPrisma = createMockPrisma()
    vi.clearAllMocks()
  })

  test('creates a cron job and returns confirmation', async () => {
    vi.mocked(cronService.create).mockResolvedValue({
      id: 'cron-1',
      name: 'Daily backup',
      schedule: '0 0 * * *',
    } as never)

    const toolCall = {
      id: 'tc-1',
      name: 'create_cron',
      arguments: { name: 'Daily backup', schedule: '0 0 * * *', prompt: 'Run backup' },
    }
    const result = await executeCreateCron(toolCall, baseContext)

    expect(cronService.create).toHaveBeenCalledWith({
      name: 'Daily backup',
      schedule: '0 0 * * *',
      prompt: 'Run backup',
      type: 'agent',
      workspaceId: 'ws-1',
      sessionId: 'session-1',
    })
    expect(result.output).toContain('Daily backup')
    expect(result.output).toContain('created successfully')
  })

  test('uses default values when args are missing', async () => {
    vi.mocked(cronService.create).mockResolvedValue({
      id: 'cron-2',
      name: 'Unnamed cron',
      schedule: '*/30 * * * *',
    } as never)

    const toolCall = { id: 'tc-1', name: 'create_cron', arguments: {} }
    await executeCreateCron(toolCall, baseContext)

    expect(cronService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Unnamed cron',
        schedule: '*/30 * * * *',
        prompt: '',
      }),
    )
  })
})

describe('executeListCrons', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('returns formatted job list', async () => {
    vi.mocked(cronService.list).mockResolvedValue([
      {
        id: 'cron-1',
        name: 'Job A',
        schedule: '*/5 * * * *',
        type: 'agent',
        enabled: true,
        scopeLabel: 'workspace',
        workspaceName: 'WS',
        conversationTitle: null,
        lastRunAt: new Date('2025-01-01T00:00:00Z'),
        lastRunStatus: 'completed',
      },
    ] as never)

    const result = await executeListCrons(baseContext)

    expect(result.output).toContain('Job A')
    expect(result.output).toContain('*/5 * * * *')
    expect(result.output).toContain('agent')
  })

  test('returns message when no jobs exist', async () => {
    vi.mocked(cronService.list).mockResolvedValue([] as never)

    const result = await executeListCrons(baseContext)

    expect(result.output).toBe('No cron jobs configured.')
  })
})

describe('executeDeleteCron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('deletes a cron job and returns confirmation', async () => {
    vi.mocked(cronService.delete).mockResolvedValue(undefined as never)

    const toolCall = { id: 'tc-1', name: 'delete_cron', arguments: { id: 'cron-1' } }
    const result = await executeDeleteCron(toolCall)

    expect(cronService.delete).toHaveBeenCalledWith('cron-1')
    expect(result.output).toContain('deleted successfully')
  })

  test('returns error when deletion fails', async () => {
    vi.mocked(cronService.delete).mockRejectedValue(new Error('Not found'))

    const toolCall = { id: 'tc-1', name: 'delete_cron', arguments: { id: 'bad-id' } }
    const result = await executeDeleteCron(toolCall)

    expect(result.error).toBe('Not found')
  })
})

describe('executeDiscoverTools', () => {
  beforeEach(() => {
    mockPrisma = createMockPrisma()
    vi.clearAllMocks()
  })

  test('returns discovered tools via semantic search', async () => {
    mockPrisma.workspaceCapability.findMany.mockResolvedValue([
      { capability: { slug: 'browser-automation' } },
    ] as never)
    vi.mocked(toolDiscoveryService.search).mockResolvedValue([
      {
        slug: 'browser-automation',
        name: 'Browser',
        tools: [{ name: 'run_browser_script', description: 'Run script' }],
        instructions: 'Use browser',
      },
    ] as never)

    const toolCall = {
      id: 'tc-1',
      name: 'discover_tools',
      arguments: { query: 'browser' },
    }
    const result = await executeDiscoverTools(toolCall, baseContext)

    const parsed = JSON.parse(result.output)
    expect(parsed.type).toBe('discovery_result')
    expect(parsed.discovered).toHaveLength(1)
    // run_browser_script should be annotated as delegation-only
    expect(parsed.discovered[0].tools[0].description).toContain('DELEGATION-ONLY')
  })

  test('returns empty discovery when no tools match', async () => {
    mockPrisma.workspaceCapability.findMany.mockResolvedValue([] as never)
    vi.mocked(toolDiscoveryService.search).mockResolvedValue([] as never)

    const toolCall = {
      id: 'tc-1',
      name: 'discover_tools',
      arguments: { query: 'nonexistent' },
    }
    const result = await executeDiscoverTools(toolCall, baseContext)

    const parsed = JSON.parse(result.output)
    expect(parsed.discovered).toHaveLength(0)
    expect(parsed.hint).toBeTruthy()
  })

  test('lists all tools when list_all is true', async () => {
    mockPrisma.workspaceCapability.findMany.mockResolvedValue([] as never)
    vi.mocked(toolDiscoveryService.listAvailable).mockResolvedValue([
      { slug: 'cap-a', name: 'Cap A', tools: [] },
    ] as never)

    const toolCall = {
      id: 'tc-1',
      name: 'discover_tools',
      arguments: { query: '', list_all: true },
    }
    const result = await executeDiscoverTools(toolCall, baseContext)

    const parsed = JSON.parse(result.output)
    expect(parsed.type).toBe('tool_listing')
    expect(parsed.available).toHaveLength(1)
  })
})

describe('executeDelegateTask', () => {
  beforeEach(() => {
    mockPrisma = createMockPrisma()
    vi.clearAllMocks()
  })

  test('delegates task to sub-agent and returns formatted result', async () => {
    vi.mocked(subAgentService.runSubAgent).mockResolvedValue({
      role: 'explore',
      result: 'Found the answer',
      success: true,
      iterationsUsed: 3,
      toolExecutions: [],
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
    } as never)

    const toolCall = {
      id: 'tc-1',
      name: 'delegate_task',
      arguments: { role: 'explore', task: 'Find info' },
    }
    const result = await executeDelegateTask(toolCall, baseContext)

    expect(subAgentService.runSubAgent).toHaveBeenCalled()
    expect(result.output).toContain('Sub-Agent Result')
    expect(result.output).toContain('Found the answer')
    expect(result.output).toContain('Iterations: 3')
    expect(result.error).toBeUndefined()
  })

  test('returns error when role is missing', async () => {
    const toolCall = {
      id: 'tc-1',
      name: 'delegate_task',
      arguments: { role: '', task: 'Do something' },
    }
    const result = await executeDelegateTask(toolCall, baseContext)

    expect(result.error).toBe('Both role and task are required')
  })

  test('returns error when task is missing', async () => {
    const toolCall = {
      id: 'tc-1',
      name: 'delegate_task',
      arguments: { role: 'explore', task: '' },
    }
    const result = await executeDelegateTask(toolCall, baseContext)

    expect(result.error).toBe('Both role and task are required')
  })

  test('returns error for invalid role', async () => {
    const toolCall = {
      id: 'tc-1',
      name: 'delegate_task',
      arguments: { role: 'invalid_role', task: 'test' },
    }
    const result = await executeDelegateTask(toolCall, baseContext)

    expect(result.error).toContain('Invalid role')
    expect(result.error).toContain('invalid_role')
  })

  test('persists sub-agent tool executions to DB', async () => {
    vi.mocked(subAgentService.runSubAgent).mockResolvedValue({
      role: 'execute',
      result: 'Done',
      success: true,
      iterationsUsed: 1,
      toolExecutions: [
        {
          capabilitySlug: 'cap-1',
          toolName: 'run_bash',
          input: { command: 'ls' },
          output: 'files',
          durationMs: 5,
        },
      ],
    } as never)
    mockPrisma.$transaction.mockResolvedValue([{ id: 'sub-exec-1' }] as never)

    const toolCall = {
      id: 'tc-1',
      name: 'delegate_task',
      arguments: { role: 'execute', task: 'run ls' },
    }
    const result = await executeDelegateTask(toolCall, baseContext)

    expect(mockPrisma.$transaction).toHaveBeenCalled()
    expect(result.subAgentExecutionIds).toEqual(['sub-exec-1'])
  })

  test('closes sub-agent browser session after completion', async () => {
    vi.mocked(subAgentService.runSubAgent).mockResolvedValue({
      role: 'explore',
      result: 'Ok',
      success: true,
      iterationsUsed: 1,
      toolExecutions: [],
    } as never)

    const toolCall = {
      id: 'tc-1',
      name: 'delegate_task',
      arguments: { role: 'explore', task: 'test' },
    }
    await executeDelegateTask(toolCall, baseContext)

    expect(browserService.closeSession).toHaveBeenCalledWith('sub-tc-1')
  })

  test('reports sub-agent failure in error field', async () => {
    vi.mocked(subAgentService.runSubAgent).mockResolvedValue({
      role: 'execute',
      result: 'Partial result',
      success: false,
      iterationsUsed: 5,
      toolExecutions: [],
    } as never)

    const toolCall = {
      id: 'tc-1',
      name: 'delegate_task',
      arguments: { role: 'execute', task: 'hard task' },
    }
    const result = await executeDelegateTask(toolCall, baseContext)

    expect(result.error).toBe('Sub-agent did not complete successfully')
  })
})
