import { describe, expect, test, vi, beforeEach } from 'vitest'
import { createMockPrisma, type MockPrisma } from '@test/factories/prisma'

// ── Mocks ───────────────────────────────────────────────────────────────

let mockPrisma: MockPrisma

vi.mock('../lib/prisma.js', () => ({
  get prisma() {
    return mockPrisma
  },
}))

vi.mock('../workers/cron.worker.js', () => ({
  cronQueue: {
    add: vi.fn().mockResolvedValue(undefined),
    removeRepeatable: vi.fn().mockResolvedValue(undefined),
    getRepeatableJobs: vi.fn().mockResolvedValue([]),
    removeRepeatableByKey: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { cronService } from './cron.service.js'
import { cronQueue } from '../workers/cron.worker.js'

const mockCronQueue = vi.mocked(cronQueue)

describe('cron.service', () => {
  beforeEach(() => {
    mockPrisma = createMockPrisma()
    // Add missing methods needed by cron.service
    ;(mockPrisma.cronJob as Record<string, unknown>).findUniqueOrThrow = vi.fn().mockResolvedValue({
      id: 'cron-1',
      name: 'Test Job',
      schedule: '*/5 * * * *',
      enabled: true,
      builtin: false,
      type: 'agent',
      handler: null,
      prompt: 'test prompt',
      workspaceId: null,
      sessionId: null,
    })
    ;(mockPrisma.cronJob as Record<string, unknown>).findFirst = vi.fn().mockResolvedValue(null)
    ;(mockPrisma.cronJob as Record<string, unknown>).deleteMany = vi
      .fn()
      .mockResolvedValue({ count: 0 })

    vi.clearAllMocks()
  })

  // ── list ──────────────────────────────────────────────────────────────

  describe('list', () => {
    test('returns empty array when no OR conditions apply', async () => {
      const result = await cronService.list({
        includeGlobal: false,
        includeWorkspace: false,
        includeConversation: false,
      })
      expect(result).toEqual([])
    })

    test('queries global jobs by default when no workspaceId', async () => {
      mockPrisma.cronJob.findMany.mockResolvedValueOnce([
        {
          id: 'j1',
          name: 'Global Job',
          workspaceId: null,
          sessionId: null,
          builtin: true,
          schedule: '* * * * *',
          enabled: true,
        },
      ])

      const result = await cronService.list()
      expect(mockPrisma.cronJob.findMany).toHaveBeenCalled()
      expect(result).toHaveLength(1)
      expect(result[0].scope).toBe('global')
      expect(result[0].scopeLabel).toBe('Global')
    })

    test('assigns workspace scope correctly', async () => {
      mockPrisma.cronJob.findMany.mockResolvedValueOnce([
        {
          id: 'j2',
          name: 'Workspace Job',
          workspaceId: 'ws-1',
          sessionId: null,
          builtin: false,
          schedule: '0 * * * *',
          enabled: true,
        },
      ])
      mockPrisma.workspace.findMany.mockResolvedValueOnce([{ id: 'ws-1', name: 'My Workspace' }])

      const result = await cronService.list({ workspaceId: 'ws-1' })
      expect(result).toHaveLength(1)
      expect(result[0].scope).toBe('workspace')
      expect(result[0].workspaceName).toBe('My Workspace')
    })

    test('assigns conversation scope correctly', async () => {
      mockPrisma.cronJob.findMany.mockResolvedValueOnce([
        {
          id: 'j3',
          name: 'Conv Job',
          workspaceId: 'ws-1',
          sessionId: 'sess-1',
          builtin: false,
          schedule: '0 0 * * *',
          enabled: true,
        },
      ])
      mockPrisma.workspace.findMany.mockResolvedValueOnce([{ id: 'ws-1', name: 'WS' }])
      mockPrisma.chatSession.findMany.mockResolvedValueOnce([{ id: 'sess-1', title: 'My Chat' }])

      const result = await cronService.list({
        workspaceId: 'ws-1',
        sessionId: 'sess-1',
      })
      expect(result[0].scope).toBe('conversation')
      expect(result[0].conversationTitle).toBe('My Chat')
    })
  })

  // ── getById ───────────────────────────────────────────────────────────

  describe('getById', () => {
    test('delegates to prisma findUniqueOrThrow', async () => {
      const findUniqueOrThrow = (mockPrisma.cronJob as Record<string, ReturnType<typeof vi.fn>>)
        .findUniqueOrThrow
      findUniqueOrThrow.mockResolvedValueOnce({ id: 'cron-1', name: 'Test' })

      const result = await cronService.getById('cron-1')
      expect(result).toEqual({ id: 'cron-1', name: 'Test' })
      expect(findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: 'cron-1' } })
    })
  })

  // ── create ────────────────────────────────────────────────────────────

  describe('create', () => {
    test('creates a cron job and adds repeatable when enabled', async () => {
      const created = {
        id: 'new-cron',
        name: 'New Job',
        schedule: '*/10 * * * *',
        enabled: true,
        type: 'agent',
      }
      mockPrisma.cronJob.create.mockResolvedValueOnce(created)

      const result = await cronService.create({
        name: 'New Job',
        schedule: '*/10 * * * *',
      })

      expect(result).toEqual(created)
      expect(mockPrisma.cronJob.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: 'New Job',
          schedule: '*/10 * * * *',
          type: 'agent',
          enabled: true,
        }),
      })
      expect(mockCronQueue.add).toHaveBeenCalledWith(
        'cron-execute',
        { cronJobId: 'new-cron' },
        expect.objectContaining({
          repeat: { pattern: '*/10 * * * *' },
          jobId: 'cron:new-cron',
        }),
      )
    })

    test('creates a cron job without adding repeatable when disabled', async () => {
      mockPrisma.cronJob.create.mockResolvedValueOnce({
        id: 'new-cron',
        enabled: false,
        schedule: '*/10 * * * *',
      })

      await cronService.create({
        name: 'Disabled Job',
        schedule: '*/10 * * * *',
        enabled: false,
      })

      expect(mockCronQueue.add).not.toHaveBeenCalled()
    })
  })

  // ── update ────────────────────────────────────────────────────────────

  describe('update', () => {
    test('removes old repeatable and adds new one when enabled', async () => {
      const findUniqueOrThrow = (mockPrisma.cronJob as Record<string, ReturnType<typeof vi.fn>>)
        .findUniqueOrThrow
      findUniqueOrThrow.mockResolvedValueOnce({
        id: 'cron-1',
        schedule: '*/5 * * * *',
        enabled: true,
      })
      mockPrisma.cronJob.update.mockResolvedValueOnce({
        id: 'cron-1',
        schedule: '*/10 * * * *',
        enabled: true,
      })

      await cronService.update('cron-1', { schedule: '*/10 * * * *' })

      expect(mockCronQueue.removeRepeatable).toHaveBeenCalledWith(
        'cron-execute',
        expect.objectContaining({ pattern: '*/5 * * * *' }),
      )
      expect(mockCronQueue.add).toHaveBeenCalled()
    })

    test('does not add repeatable when updated job is disabled', async () => {
      const findUniqueOrThrow = (mockPrisma.cronJob as Record<string, ReturnType<typeof vi.fn>>)
        .findUniqueOrThrow
      findUniqueOrThrow.mockResolvedValueOnce({
        id: 'cron-1',
        schedule: '*/5 * * * *',
        enabled: true,
      })
      mockPrisma.cronJob.update.mockResolvedValueOnce({
        id: 'cron-1',
        schedule: '*/5 * * * *',
        enabled: false,
      })

      await cronService.update('cron-1', { enabled: false })

      expect(mockCronQueue.removeRepeatable).toHaveBeenCalled()
      expect(mockCronQueue.add).not.toHaveBeenCalled()
    })
  })

  // ── delete ────────────────────────────────────────────────────────────

  describe('delete', () => {
    test('deletes a non-builtin cron job', async () => {
      const findUniqueOrThrow = (mockPrisma.cronJob as Record<string, ReturnType<typeof vi.fn>>)
        .findUniqueOrThrow
      findUniqueOrThrow.mockResolvedValueOnce({
        id: 'cron-1',
        schedule: '*/5 * * * *',
        builtin: false,
      })

      await cronService.delete('cron-1')

      expect(mockCronQueue.removeRepeatable).toHaveBeenCalled()
      expect(mockPrisma.cronJob.delete).toHaveBeenCalledWith({
        where: { id: 'cron-1' },
      })
    })

    test('throws when trying to delete a builtin cron job', async () => {
      const findUniqueOrThrow = (mockPrisma.cronJob as Record<string, ReturnType<typeof vi.fn>>)
        .findUniqueOrThrow
      findUniqueOrThrow.mockResolvedValueOnce({
        id: 'builtin-1',
        schedule: '*/5 * * * *',
        builtin: true,
      })

      await expect(cronService.delete('builtin-1')).rejects.toThrow(
        'Cannot delete built-in cron jobs',
      )
    })
  })

  // ── toggleEnabled ─────────────────────────────────────────────────────

  describe('toggleEnabled', () => {
    test('adds repeatable job when enabling', async () => {
      const findUniqueOrThrow = (mockPrisma.cronJob as Record<string, ReturnType<typeof vi.fn>>)
        .findUniqueOrThrow
      findUniqueOrThrow.mockResolvedValueOnce({
        id: 'cron-1',
        schedule: '*/5 * * * *',
      })
      mockPrisma.cronJob.update.mockResolvedValueOnce({
        id: 'cron-1',
        enabled: true,
      })

      await cronService.toggleEnabled('cron-1', true)
      expect(mockCronQueue.add).toHaveBeenCalled()
      expect(mockCronQueue.removeRepeatable).not.toHaveBeenCalled()
    })

    test('removes repeatable job when disabling', async () => {
      const findUniqueOrThrow = (mockPrisma.cronJob as Record<string, ReturnType<typeof vi.fn>>)
        .findUniqueOrThrow
      findUniqueOrThrow.mockResolvedValueOnce({
        id: 'cron-1',
        schedule: '*/5 * * * *',
      })
      mockPrisma.cronJob.update.mockResolvedValueOnce({
        id: 'cron-1',
        enabled: false,
      })

      await cronService.toggleEnabled('cron-1', false)
      expect(mockCronQueue.removeRepeatable).toHaveBeenCalled()
      expect(mockCronQueue.add).not.toHaveBeenCalled()
    })
  })

  // ── triggerNow ────────────────────────────────────────────────────────

  describe('triggerNow', () => {
    test('adds a one-time job to the queue', async () => {
      const findUniqueOrThrow = (mockPrisma.cronJob as Record<string, ReturnType<typeof vi.fn>>)
        .findUniqueOrThrow
      findUniqueOrThrow.mockResolvedValueOnce({
        id: 'cron-1',
        schedule: '*/5 * * * *',
      })

      await cronService.triggerNow('cron-1')
      expect(mockCronQueue.add).toHaveBeenCalledWith(
        'cron-execute',
        { cronJobId: 'cron-1' },
        expect.objectContaining({
          jobId: expect.stringContaining('trigger:cron-1:'),
        }),
      )
    })
  })

  // ── registerBuiltinJobs ───────────────────────────────────────────────

  describe('registerBuiltinJobs', () => {
    test('creates builtin jobs that do not exist yet', async () => {
      const findFirst = (mockPrisma.cronJob as Record<string, ReturnType<typeof vi.fn>>).findFirst
      findFirst.mockResolvedValueOnce(null) // cleanupIdleContainers not found

      await cronService.registerBuiltinJobs()

      const deleteMany = (mockPrisma.cronJob as Record<string, ReturnType<typeof vi.fn>>).deleteMany
      expect(deleteMany).toHaveBeenCalledWith({
        where: { handler: 'cleanupStaleSandboxes', builtin: true },
      })
      expect(mockPrisma.cronJob.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          handler: 'cleanupIdleContainers',
          builtin: true,
        }),
      })
    })

    test('skips existing builtin jobs', async () => {
      const findFirst = (mockPrisma.cronJob as Record<string, ReturnType<typeof vi.fn>>).findFirst
      findFirst.mockResolvedValueOnce({ id: 'existing', handler: 'cleanupIdleContainers' })

      await cronService.registerBuiltinJobs()

      // Should NOT create since it already exists
      expect(mockPrisma.cronJob.create).not.toHaveBeenCalled()
    })
  })

  // ── syncAllJobs ───────────────────────────────────────────────────────

  describe('syncAllJobs', () => {
    test('removes orphaned repeatable jobs from BullMQ', async () => {
      mockPrisma.cronJob.findMany.mockResolvedValueOnce([
        { id: 'cron-1', enabled: true, schedule: '*/5 * * * *' },
      ])
      mockCronQueue.getRepeatableJobs.mockResolvedValueOnce([
        { key: 'cron:cron-1:abc', name: 'cron-execute' },
        { key: 'cron:orphan:def', name: 'cron-execute' },
      ])

      await cronService.syncAllJobs()

      expect(mockCronQueue.removeRepeatableByKey).toHaveBeenCalledWith('cron:orphan:def')
      expect(mockCronQueue.removeRepeatableByKey).not.toHaveBeenCalledWith('cron:cron-1:abc')
    })

    test('adds enabled jobs that are missing from BullMQ', async () => {
      mockPrisma.cronJob.findMany.mockResolvedValueOnce([
        { id: 'cron-1', enabled: true, schedule: '*/5 * * * *' },
        { id: 'cron-2', enabled: false, schedule: '0 * * * *' },
      ])
      mockCronQueue.getRepeatableJobs.mockResolvedValueOnce([])

      await cronService.syncAllJobs()

      // Only cron-1 should be added (cron-2 is disabled)
      expect(mockCronQueue.add).toHaveBeenCalledTimes(1)
      expect(mockCronQueue.add).toHaveBeenCalledWith(
        'cron-execute',
        { cronJobId: 'cron-1' },
        expect.objectContaining({ jobId: 'cron:cron-1' }),
      )
    })
  })
})
