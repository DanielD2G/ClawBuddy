import { vi } from 'vitest'

/**
 * Create a mock Prisma client with vi.fn() stubs for common model methods.
 * Each method returns sensible defaults (empty arrays for findMany, null for findUnique, etc.).
 */
export function createMockPrisma() {
  const mockId = () => `mock-${Math.random().toString(36).slice(2, 10)}`
  const now = new Date()

  return {
    chatSession: {
      create: vi.fn().mockResolvedValue({ id: mockId(), createdAt: now, updatedAt: now }),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ id: mockId(), workspaceId: mockId(), title: null }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({ id: mockId() }),
      delete: vi.fn().mockResolvedValue({ id: mockId() }),
    },
    chatMessage: {
      create: vi.fn().mockResolvedValue({ id: mockId(), createdAt: now }),
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockResolvedValue({ id: mockId() }),
      delete: vi.fn().mockResolvedValue({ id: mockId() }),
    },
    workspace: {
      create: vi.fn().mockResolvedValue({ id: mockId(), createdAt: now }),
      findUnique: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ id: mockId(), containerId: null, containerStatus: 'stopped' }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({ id: mockId() }),
      delete: vi.fn().mockResolvedValue({ id: mockId() }),
    },
    document: {
      create: vi.fn().mockResolvedValue({ id: mockId(), createdAt: now }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({ id: mockId() }),
      delete: vi.fn().mockResolvedValue({ id: mockId() }),
    },
    documentChunk: {
      create: vi.fn().mockResolvedValue({ id: mockId() }),
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      delete: vi.fn().mockResolvedValue({ id: mockId() }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    capability: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: mockId(), slug: 'test-cap' }),
      create: vi.fn().mockResolvedValue({ id: mockId() }),
      update: vi.fn().mockResolvedValue({ id: mockId() }),
      upsert: vi.fn().mockResolvedValue({ id: mockId() }),
      delete: vi.fn().mockResolvedValue({ id: mockId() }),
    },
    workspaceCapability: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: mockId() }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockResolvedValue({ id: mockId() }),
      upsert: vi.fn().mockResolvedValue({ id: mockId() }),
      delete: vi.fn().mockResolvedValue({ id: mockId() }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    toolExecution: {
      create: vi.fn().mockResolvedValue({ id: mockId(), createdAt: now }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({ id: mockId() }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    appSettings: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: 'singleton' }),
      update: vi.fn().mockResolvedValue({ id: 'singleton' }),
      create: vi.fn().mockResolvedValue({ id: 'singleton' }),
    },
    sandboxSession: {
      create: vi.fn().mockResolvedValue({ id: mockId(), status: 'running' }),
      findUnique: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: mockId(), containerId: null }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({ id: mockId() }),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    tokenUsage: {
      create: vi.fn().mockResolvedValue({ id: mockId() }),
      upsert: vi.fn().mockResolvedValue({ id: mockId() }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    toolApproval: {
      create: vi.fn().mockResolvedValue({ id: mockId() }),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    cronJob: {
      create: vi.fn().mockResolvedValue({ id: mockId() }),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({ id: mockId() }),
      delete: vi.fn().mockResolvedValue({ id: mockId() }),
    },
    $transaction: vi.fn().mockImplementation(async (cb: unknown) => {
      if (typeof cb === 'function') {
        // Execute the callback with this mock prisma instance as the transaction client
        return cb(createMockPrisma())
      }
      // If it's an array of promises, resolve them all
      if (Array.isArray(cb)) {
        return Promise.all(cb)
      }
      return undefined
    }),
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(0),
  }
}

export type MockPrisma = ReturnType<typeof createMockPrisma>
