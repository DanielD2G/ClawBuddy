import { describe, expect, test, vi, beforeEach } from 'vitest'
import { createMockPrisma, type MockPrisma } from '@test/factories/prisma'
import { PassThrough } from 'stream'

// ── Mocks ───────────────────────────────────────────────────────────────

let mockPrisma: MockPrisma

vi.mock('../lib/prisma.js', () => ({
  get prisma() {
    return mockPrisma
  },
}))

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

// Mock container and Docker
const mockExecInspect = vi.fn().mockResolvedValue({ ExitCode: 0 })
const mockContainerExec = vi.fn()
const mockContainerStart = vi.fn().mockResolvedValue(undefined)
const mockContainerStop = vi.fn().mockResolvedValue(undefined)
const mockContainerRemove = vi.fn().mockResolvedValue(undefined)
const mockContainerInspect = vi.fn()
const mockContainerPutArchive = vi.fn().mockResolvedValue(undefined)
const mockContainerGetArchive = vi.fn()
const mockCreateContainer = vi.fn()
const mockGetContainer = vi.fn()
const mockGetImage = vi.fn()
const mockListContainers = vi.fn().mockResolvedValue([])
const mockPull = vi.fn()
const mockDemuxStream = vi.fn()

function createMockContainer(id = 'container-abc123') {
  return {
    id,
    exec: mockContainerExec,
    start: mockContainerStart,
    stop: mockContainerStop,
    remove: mockContainerRemove,
    inspect: mockContainerInspect,
    putArchive: mockContainerPutArchive,
    getArchive: mockContainerGetArchive,
  }
}

vi.mock('dockerode', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      createContainer: mockCreateContainer,
      getContainer: mockGetContainer,
      getImage: mockGetImage,
      listContainers: mockListContainers,
      pull: mockPull,
      modem: {
        demuxStream: mockDemuxStream,
        followProgress: vi.fn(),
      },
    })),
  }
})

vi.mock('./image-builder.service.js', () => ({
  imageBuilderService: {
    getOrBuildImage: vi.fn().mockResolvedValue('clawbuddy-sandbox-base-v2'),
  },
}))

vi.mock('../lib/sanitize.js', () => ({
  stripNullBytes: vi.fn((s: string) => s),
}))

vi.mock('../constants.js', () => ({
  SANDBOX_MAX_TIMEOUT_MS: 300_000,
  SANDBOX_IDLE_TIMEOUT_MS: 600_000,
  SANDBOX_MEMORY_BYTES: 512 * 1024 * 1024,
  SANDBOX_NANOCPUS: 1_000_000_000,
  SANDBOX_PID_LIMIT: 100,
  SANDBOX_DEFAULT_EXEC_TIMEOUT_S: 30,
  EXEC_OUTPUT_MAX_BYTES: 50_000,
  SANDBOX_TIMEOUT_EXIT_CODE: 124,
  SANDBOX_STOP_TIMEOUT_S: 5,
  SANDBOX_BASE_IMAGE: 'clawbuddy-sandbox-base-v2',
  SANDBOX_FALLBACK_IMAGE: 'ubuntu:22.04',
}))

// ── Import SUT after mocks ──────────────────────────────────────────────

const { sandboxService } = await import('./sandbox.service.js')

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Set up mockContainerExec to return an exec object whose start callback
 * provides a stream. The stream emits 'end' after a short delay so that
 * the calling code has time to attach listeners.
 */
function setupExecStream(stdout = '', stderr = '', exitCode = 0) {
  const stream = new PassThrough()

  const execObj = {
    start: (_opts: unknown, cb: (err: Error | null, stream: PassThrough) => void) => {
      cb(null, stream)
      // Emit end after listeners are attached (inside the callback chain)
      setTimeout(() => stream.emit('end'), 5)
    },
    inspect: vi.fn().mockResolvedValue({ ExitCode: exitCode }),
  }

  mockContainerExec.mockResolvedValue(execObj)

  mockDemuxStream.mockImplementation(
    (_stream: PassThrough, stdoutPT: PassThrough, stderrPT: PassThrough) => {
      if (stdout) stdoutPT.write(Buffer.from(stdout))
      if (stderr) stderrPT.write(Buffer.from(stderr))
    },
  )

  return stream
}

/**
 * Set up a simple exec mock for execSimple (used internally during container setup).
 * Each call creates a fresh stream that ends immediately.
 */
function setupExecSimple() {
  mockContainerExec.mockImplementation(() => {
    const stream = new PassThrough()
    return Promise.resolve({
      start: (_opts: unknown, cb: (err: Error | null, stream: PassThrough) => void) => {
        cb(null, stream)
        setTimeout(() => stream.emit('end'), 2)
      },
      inspect: mockExecInspect,
    })
  })
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('sandboxService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    mockPrisma = createMockPrisma()

    // Default: getContainer returns a full mock container
    mockGetContainer.mockReturnValue(createMockContainer())

    // Default image inspect succeeds
    mockGetImage.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({}),
    })
  })

  // ── getOrCreateWorkspaceContainer ───────────────────────────────────

  describe('getOrCreateWorkspaceContainer', () => {
    test('creates new container when workspace has no containerId', async () => {
      const workspaceId = 'ws-1'
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        id: workspaceId,
        containerId: null,
        containerStatus: 'stopped',
      })

      const container = createMockContainer('new-container-id')
      mockCreateContainer.mockResolvedValue(container)
      setupExecSimple()

      const result = await sandboxService.getOrCreateWorkspaceContainer(workspaceId, {
        networkAccess: true,
      })

      expect(result).toBe('new-container-id')
      expect(mockCreateContainer).toHaveBeenCalledOnce()
      expect(mockContainerStart).toHaveBeenCalledOnce()
      expect(mockPrisma.workspace.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: workspaceId },
          data: expect.objectContaining({
            containerId: 'new-container-id',
            containerStatus: 'running',
          }),
        }),
      )
    })

    test('returns existing container when running and alive', async () => {
      const workspaceId = 'ws-2'
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        id: workspaceId,
        containerId: 'existing-container',
        containerStatus: 'running',
      })

      mockGetContainer.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ State: { Running: true } }),
      })

      const result = await sandboxService.getOrCreateWorkspaceContainer(workspaceId, {
        networkAccess: true,
      })

      expect(result).toBe('existing-container')
      expect(mockCreateContainer).not.toHaveBeenCalled()
    })

    test('recreates container when existing container is gone', async () => {
      const workspaceId = 'ws-3'
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        id: workspaceId,
        containerId: 'dead-container',
        containerStatus: 'running',
      })

      // Inspect fails (container gone), then remove for cleanup
      mockGetContainer.mockReturnValue({
        inspect: vi.fn().mockRejectedValue(new Error('no such container')),
        remove: vi.fn().mockResolvedValue(undefined),
      })

      const newContainer = createMockContainer('replaced-container')
      mockCreateContainer.mockResolvedValue(newContainer)
      setupExecSimple()

      const result = await sandboxService.getOrCreateWorkspaceContainer(workspaceId, {
        networkAccess: false,
      })

      expect(result).toBe('replaced-container')
      expect(mockCreateContainer).toHaveBeenCalledOnce()
    })

    test('creates container with correct Docker config', async () => {
      const workspaceId = 'ws-config'
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        id: workspaceId,
        containerId: null,
        containerStatus: 'stopped',
      })

      const container = createMockContainer('cfg-container')
      mockCreateContainer.mockResolvedValue(container)
      setupExecSimple()

      await sandboxService.getOrCreateWorkspaceContainer(workspaceId, {
        networkAccess: false,
        dockerSocket: true,
      })

      const createCall = mockCreateContainer.mock.calls[0][0]
      expect(createCall.Image).toBe('clawbuddy-sandbox-base-v2')
      expect(createCall.Cmd).toEqual(['sleep', 'infinity'])
      expect(createCall.WorkingDir).toBe('/workspace')
      expect(createCall.HostConfig.NetworkMode).toBe('none')
      expect(createCall.HostConfig.Memory).toBe(512 * 1024 * 1024)
      expect(createCall.HostConfig.Binds).toContain('/var/run/docker.sock:/var/run/docker.sock')
      expect(createCall.Labels['clawbuddy.workspace']).toBe(workspaceId)
    })

    test('filters env vars starting with underscore', async () => {
      const workspaceId = 'ws-env'
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        id: workspaceId,
        containerId: null,
        containerStatus: 'stopped',
      })

      const container = createMockContainer('env-container')
      mockCreateContainer.mockResolvedValue(container)
      setupExecSimple()

      await sandboxService.getOrCreateWorkspaceContainer(
        workspaceId,
        { networkAccess: true },
        { API_KEY: 'abc', _INTERNAL: 'secret' },
      )

      const createCall = mockCreateContainer.mock.calls[0][0]
      expect(createCall.Env).toEqual(['API_KEY=abc'])
    })
  })

  // ── execInWorkspace ─────────────────────────────────────────────────

  describe('execInWorkspace', () => {
    test('executes command in running workspace container', async () => {
      const workspaceId = 'ws-exec'
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        id: workspaceId,
        containerId: 'exec-container',
        containerStatus: 'running',
      })

      mockGetContainer.mockReturnValue(createMockContainer('exec-container'))
      setupExecStream('hello world', '', 0)

      const result = await sandboxService.execInWorkspace(workspaceId, 'echo hello world')

      expect(result.stdout).toBe('hello world')
      expect(result.exitCode).toBe(0)
      expect(mockPrisma.workspace.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ containerLastActivityAt: expect.any(Date) }),
        }),
      )
    })

    test('throws when container is not running', async () => {
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        id: 'ws-no-container',
        containerId: null,
        containerStatus: 'stopped',
      })

      await expect(sandboxService.execInWorkspace('ws-no-container', 'ls')).rejects.toThrow(
        'Workspace container is not running',
      )
    })

    test('recreates container on "no such container" error', async () => {
      const workspaceId = 'ws-gone'

      // First findUniqueOrThrow: workspace has running container
      mockPrisma.workspace.findUniqueOrThrow
        .mockResolvedValueOnce({
          id: workspaceId,
          containerId: 'gone-container',
          containerStatus: 'running',
        })
        // getOrCreateWorkspaceContainer lookup
        .mockResolvedValueOnce({
          id: workspaceId,
          containerId: null,
          containerStatus: 'stopped',
        })
        // After recreation, final lookup
        .mockResolvedValueOnce({
          id: workspaceId,
          containerId: 'new-exec-container',
          containerStatus: 'running',
        })

      // First exec attempt throws "no such container"
      let callCount = 0
      mockGetContainer.mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return {
            ...createMockContainer('gone-container'),
            exec: vi.fn().mockRejectedValue(new Error('no such container')),
          }
        }
        return createMockContainer('new-exec-container')
      })

      const newContainer = createMockContainer('new-exec-container')
      mockCreateContainer.mockResolvedValue(newContainer)

      // setupExecSimple for container creation, then the retry exec
      mockContainerExec.mockImplementation(() => {
        const s = new PassThrough()
        return Promise.resolve({
          start: (_opts: unknown, cb: (err: Error | null, stream: PassThrough) => void) => {
            cb(null, s)
            setTimeout(() => s.emit('end'), 5)
          },
          inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
        })
      })

      mockDemuxStream.mockImplementation((_stream: PassThrough, stdoutPT: PassThrough) => {
        stdoutPT.write(Buffer.from('recovered'))
      })

      const result = await sandboxService.execInWorkspace(workspaceId, 'echo recovered')

      expect(result.stdout).toBe('recovered')
    })
  })

  // ── _execInContainerDirect ──────────────────────────────────────────

  describe('_execInContainerDirect', () => {
    test('returns stdout and stderr from command execution', async () => {
      mockGetContainer.mockReturnValue(createMockContainer())
      setupExecStream('output text', 'warn text', 0)

      const result = await sandboxService._execInContainerDirect('container-abc123', 'ls')

      expect(result.stdout).toBe('output text')
      expect(result.stderr).toBe('warn text')
      expect(result.exitCode).toBe(0)
    })

    test('returns non-zero exit code on failure', async () => {
      mockGetContainer.mockReturnValue(createMockContainer())
      setupExecStream('', 'command not found', 127)

      const result = await sandboxService._execInContainerDirect('container-abc123', 'badcmd')

      expect(result.exitCode).toBe(127)
      expect(result.stderr).toBe('command not found')
    })

    test('copies stdout to stderr when exit code is non-zero and stderr is empty', async () => {
      mockGetContainer.mockReturnValue(createMockContainer())
      setupExecStream('error output on stdout', '', 1)

      const result = await sandboxService._execInContainerDirect('container-abc123', 'failing')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toBe('error output on stdout')
    })

    test('rejects when exec.start returns an error', async () => {
      mockGetContainer.mockReturnValue(createMockContainer())

      mockContainerExec.mockResolvedValue({
        start: (_opts: unknown, cb: (err: Error | null, stream: null) => void) => {
          cb(new Error('exec start failed'), null)
        },
        inspect: mockExecInspect,
      })

      await expect(sandboxService._execInContainerDirect('container-abc123', 'ls')).rejects.toThrow(
        'exec start failed',
      )
    })

    test('rejects when exec.start returns no stream', async () => {
      mockGetContainer.mockReturnValue(createMockContainer())

      mockContainerExec.mockResolvedValue({
        start: (_opts: unknown, cb: (err: null, stream: null) => void) => {
          cb(null, null)
        },
        inspect: mockExecInspect,
      })

      await expect(sandboxService._execInContainerDirect('container-abc123', 'ls')).rejects.toThrow(
        'No stream returned',
      )
    })

    test('resolves with timeout exit code when command exceeds time limit', async () => {
      vi.useFakeTimers()

      mockGetContainer.mockReturnValue(createMockContainer())

      const stream = new PassThrough()
      mockContainerExec.mockResolvedValue({
        start: (_opts: unknown, cb: (err: null, stream: PassThrough) => void) => {
          cb(null, stream)
        },
        inspect: mockExecInspect,
      })
      mockDemuxStream.mockImplementation(() => {
        // Don't write anything, simulate a hanging command
      })

      const promise = sandboxService._execInContainerDirect('container-abc123', 'sleep 999', {
        timeout: 1,
      })

      // Advance past the 1-second timeout (1000ms)
      await vi.advanceTimersByTimeAsync(1500)

      const result = await promise

      expect(result.exitCode).toBe(124)
      expect(result.stderr).toBe('[TIMEOUT] Command exceeded time limit')

      vi.useRealTimers()
    })

    test('rejects on stream error', async () => {
      mockGetContainer.mockReturnValue(createMockContainer())

      const stream = new PassThrough()
      mockContainerExec.mockResolvedValue({
        start: (_opts: unknown, cb: (err: null, stream: PassThrough) => void) => {
          cb(null, stream)
          setTimeout(() => stream.emit('error', new Error('stream broke')), 5)
        },
        inspect: mockExecInspect,
      })
      mockDemuxStream.mockImplementation(() => {})

      await expect(sandboxService._execInContainerDirect('container-abc123', 'ls')).rejects.toThrow(
        'stream broke',
      )
    })

    test('uses custom workingDir when provided', async () => {
      mockGetContainer.mockReturnValue(createMockContainer())
      setupExecStream('ok', '', 0)

      await sandboxService._execInContainerDirect('container-abc123', 'pwd', {
        workingDir: '/custom/dir',
      })

      expect(mockContainerExec).toHaveBeenCalledWith(
        expect.objectContaining({
          WorkingDir: '/custom/dir',
        }),
      )
    })
  })

  // ── writeFileToContainer ────────────────────────────────────────────

  describe('writeFileToContainer', () => {
    test('writes file to container via tar archive', async () => {
      const workspaceId = 'ws-write'
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        id: workspaceId,
        containerId: 'write-container',
        containerStatus: 'running',
      })

      const container = createMockContainer('write-container')
      mockGetContainer.mockReturnValue(container)

      // Mock _execInContainerDirect for mkdir (called internally)
      setupExecStream('', '', 0)

      const data = Buffer.from('file content here')

      await sandboxService.writeFileToContainer(workspaceId, '/workspace/test.txt', data)

      expect(mockContainerPutArchive).toHaveBeenCalledWith(expect.any(Buffer), {
        path: '/workspace',
      })
      expect(mockPrisma.workspace.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ containerLastActivityAt: expect.any(Date) }),
        }),
      )
    })

    test('throws when workspace container is not running', async () => {
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        id: 'ws-no-run',
        containerId: null,
        containerStatus: 'stopped',
      })

      await expect(
        sandboxService.writeFileToContainer('ws-no-run', '/workspace/test.txt', Buffer.from('')),
      ).rejects.toThrow('Workspace container is not running')
    })

    test('handles file paths with special characters', async () => {
      const workspaceId = 'ws-special'
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        id: workspaceId,
        containerId: 'special-container',
        containerStatus: 'running',
      })

      mockGetContainer.mockReturnValue(createMockContainer('special-container'))
      setupExecStream('', '', 0)

      await sandboxService.writeFileToContainer(
        workspaceId,
        '/workspace/path with spaces/file (1).txt',
        Buffer.from('data'),
      )

      expect(mockContainerPutArchive).toHaveBeenCalledWith(expect.any(Buffer), {
        path: '/workspace/path with spaces',
      })
    })
  })

  // ── readFileFromContainer ───────────────────────────────────────────

  describe('readFileFromContainer', () => {
    test('reads file from container via tar extract', async () => {
      const workspaceId = 'ws-read'
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        id: workspaceId,
        containerId: 'read-container',
        containerStatus: 'running',
      })

      mockGetContainer.mockReturnValue(createMockContainer('read-container'))

      // Create a fake tar stream that emits file data
      const { pack } = await import('tar-stream')
      const tarPacker = pack()
      tarPacker.entry({ name: 'test.txt' }, 'file content from container')
      tarPacker.finalize()

      mockContainerGetArchive.mockResolvedValue(tarPacker)

      const result = await sandboxService.readFileFromContainer(workspaceId, '/workspace/test.txt')

      expect(result.toString()).toBe('file content from container')
    })

    test('throws when workspace container is not running', async () => {
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        id: 'ws-no-read',
        containerId: null,
        containerStatus: 'stopped',
      })

      await expect(
        sandboxService.readFileFromContainer('ws-no-read', '/workspace/test.txt'),
      ).rejects.toThrow('Workspace container is not running')
    })
  })

  // ── stopWorkspaceContainer ──────────────────────────────────────────

  describe('stopWorkspaceContainer', () => {
    test('stops and removes container then updates DB', async () => {
      const workspaceId = 'ws-stop'
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        id: workspaceId,
        containerId: 'stop-container',
        containerStatus: 'running',
      })

      mockGetContainer.mockReturnValue(createMockContainer('stop-container'))

      await sandboxService.stopWorkspaceContainer(workspaceId)

      expect(mockContainerStop).toHaveBeenCalledWith({ t: 5 })
      expect(mockContainerRemove).toHaveBeenCalledWith({ force: true })
      expect(mockPrisma.workspace.update).toHaveBeenCalledWith({
        where: { id: workspaceId },
        data: { containerStatus: 'stopped', containerId: null },
      })
    })

    test('still updates DB when container is already gone', async () => {
      const workspaceId = 'ws-already-gone'
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        id: workspaceId,
        containerId: 'ghost-container',
        containerStatus: 'running',
      })

      mockGetContainer.mockImplementation(() => {
        throw new Error('no such container')
      })

      await sandboxService.stopWorkspaceContainer(workspaceId)

      expect(mockPrisma.workspace.update).toHaveBeenCalledWith({
        where: { id: workspaceId },
        data: { containerStatus: 'stopped', containerId: null },
      })
    })

    test('updates DB even when workspace has no containerId', async () => {
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        id: 'ws-null',
        containerId: null,
        containerStatus: 'stopped',
      })

      await sandboxService.stopWorkspaceContainer('ws-null')

      expect(mockGetContainer).not.toHaveBeenCalled()
      expect(mockPrisma.workspace.update).toHaveBeenCalledWith({
        where: { id: 'ws-null' },
        data: { containerStatus: 'stopped', containerId: null },
      })
    })
  })

  // ── getWorkspaceContainerStatus ─────────────────────────────────────

  describe('getWorkspaceContainerStatus', () => {
    test('returns running status when container is alive', async () => {
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        id: 'ws-status',
        containerId: 'status-container',
        containerStatus: 'running',
      })

      mockGetContainer.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ State: { Running: true } }),
      })

      const result = await sandboxService.getWorkspaceContainerStatus('ws-status')

      expect(result).toEqual({ status: 'running', containerId: 'status-container' })
    })

    test('marks stopped when container inspect shows not running', async () => {
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        id: 'ws-dead',
        containerId: 'dead-container',
        containerStatus: 'running',
      })

      mockGetContainer.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ State: { Running: false } }),
      })

      const result = await sandboxService.getWorkspaceContainerStatus('ws-dead')

      expect(result).toEqual({ status: 'stopped', containerId: null })
      expect(mockPrisma.workspace.update).toHaveBeenCalledWith({
        where: { id: 'ws-dead' },
        data: { containerStatus: 'stopped', containerId: null },
      })
    })

    test('marks stopped when container inspect fails', async () => {
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        id: 'ws-err',
        containerId: 'err-container',
        containerStatus: 'running',
      })

      mockGetContainer.mockReturnValue({
        inspect: vi.fn().mockRejectedValue(new Error('Docker daemon unavailable')),
      })

      const result = await sandboxService.getWorkspaceContainerStatus('ws-err')

      expect(result).toEqual({ status: 'stopped', containerId: null })
    })

    test('returns stored status when not marked as running', async () => {
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        id: 'ws-stored',
        containerId: null,
        containerStatus: 'stopped',
      })

      const result = await sandboxService.getWorkspaceContainerStatus('ws-stored')

      expect(result).toEqual({ status: 'stopped', containerId: null })
      expect(mockGetContainer).not.toHaveBeenCalled()
    })
  })

  // ── destroySandbox ──────────────────────────────────────────────────

  describe('destroySandbox', () => {
    test('stops and removes sandbox session container', async () => {
      const sessionId = 'session-1'
      mockPrisma.sandboxSession.findUniqueOrThrow.mockResolvedValue({
        id: sessionId,
        containerId: 'sandbox-container',
      })

      mockGetContainer.mockReturnValue(createMockContainer('sandbox-container'))

      await sandboxService.destroySandbox(sessionId)

      expect(mockContainerStop).toHaveBeenCalledWith({ t: 5 })
      expect(mockContainerRemove).toHaveBeenCalledWith({ force: true })
      expect(mockPrisma.sandboxSession.update).toHaveBeenCalledWith({
        where: { id: sessionId },
        data: expect.objectContaining({ status: 'stopped', stoppedAt: expect.any(Date) }),
      })
    })

    test('handles session with no containerId', async () => {
      mockPrisma.sandboxSession.findUniqueOrThrow.mockResolvedValue({
        id: 'session-none',
        containerId: null,
      })

      await sandboxService.destroySandbox('session-none')

      expect(mockGetContainer).not.toHaveBeenCalled()
      expect(mockPrisma.sandboxSession.update).toHaveBeenCalledWith({
        where: { id: 'session-none' },
        data: expect.objectContaining({ status: 'stopped' }),
      })
    })

    test('still updates DB when container is already gone', async () => {
      mockPrisma.sandboxSession.findUniqueOrThrow.mockResolvedValue({
        id: 'session-gone',
        containerId: 'gone-sandbox',
      })

      mockGetContainer.mockImplementation(() => {
        throw new Error('no such container')
      })

      await sandboxService.destroySandbox('session-gone')

      expect(mockPrisma.sandboxSession.update).toHaveBeenCalledWith({
        where: { id: 'session-gone' },
        data: expect.objectContaining({ status: 'stopped' }),
      })
    })
  })

  // ── cleanupIdleContainers ───────────────────────────────────────────

  describe('cleanupIdleContainers', () => {
    test('stops idle workspace containers', async () => {
      const idleWorkspace = {
        id: 'ws-idle',
        containerId: 'idle-container',
        containerStatus: 'running',
        containerLastActivityAt: new Date(Date.now() - 700_000),
      }

      mockPrisma.workspace.findMany.mockResolvedValue([idleWorkspace])
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue(idleWorkspace)

      mockGetContainer.mockReturnValue(createMockContainer('idle-container'))
      mockListContainers.mockResolvedValue([])
      mockPrisma.sandboxSession.findMany.mockResolvedValue([])

      await sandboxService.cleanupIdleContainers()

      expect(mockContainerStop).toHaveBeenCalled()
      expect(mockPrisma.workspace.update).toHaveBeenCalled()
    })

    test('removes orphaned Docker containers', async () => {
      mockPrisma.workspace.findMany.mockResolvedValue([])

      const orphanId = 'orphan-container-123'
      mockListContainers.mockResolvedValue([
        { Id: orphanId, Created: Math.floor((Date.now() - 700_000) / 1000) },
      ])

      mockPrisma.sandboxSession.findMany.mockResolvedValue([])

      mockGetContainer.mockReturnValue(createMockContainer(orphanId))

      await sandboxService.cleanupIdleContainers()

      expect(mockContainerStop).toHaveBeenCalled()
      expect(mockContainerRemove).toHaveBeenCalledWith({ force: true })
    })
  })

  // ── Error scenarios ─────────────────────────────────────────────────

  describe('error scenarios', () => {
    test('Docker daemon unavailable during container exec creation', async () => {
      mockGetContainer.mockReturnValue(createMockContainer())
      mockContainerExec.mockRejectedValue(new Error('Cannot connect to the Docker daemon'))

      await expect(sandboxService._execInContainerDirect('container-abc123', 'ls')).rejects.toThrow(
        'Cannot connect to the Docker daemon',
      )
    })

    test('image resolve falls back to SANDBOX_BASE_IMAGE on build failure', async () => {
      const workspaceId = 'ws-fallback'
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        id: workspaceId,
        containerId: null,
        containerStatus: 'stopped',
      })

      const { imageBuilderService } = await import('./image-builder.service.js')
      vi.mocked(imageBuilderService.getOrBuildImage).mockRejectedValueOnce(
        new Error('build failed'),
      )

      mockGetImage.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({}),
      })

      const container = createMockContainer('fallback-container')
      mockCreateContainer.mockResolvedValue(container)
      setupExecSimple()

      await sandboxService.getOrCreateWorkspaceContainer(workspaceId, { networkAccess: true })

      expect(mockCreateContainer).toHaveBeenCalledOnce()
      const createCall = mockCreateContainer.mock.calls[0][0]
      expect(createCall.Image).toBe('clawbuddy-sandbox-base-v2')
    })

    test('image pull failure when fallback image not found', async () => {
      const workspaceId = 'ws-pull-fail'
      mockPrisma.workspace.findUniqueOrThrow.mockResolvedValue({
        id: workspaceId,
        containerId: null,
        containerStatus: 'stopped',
      })

      const { imageBuilderService } = await import('./image-builder.service.js')
      vi.mocked(imageBuilderService.getOrBuildImage).mockRejectedValueOnce(
        new Error('build failed'),
      )

      // Both base and fallback image inspect fail
      mockGetImage.mockReturnValue({
        inspect: vi.fn().mockRejectedValue(new Error('No such image')),
      })

      // Pull also fails
      mockPull.mockImplementation(
        (_image: string, cb: (err: Error | null, stream: null) => void) => {
          cb(new Error('pull failed: network error'), null)
        },
      )

      await expect(
        sandboxService.getOrCreateWorkspaceContainer(workspaceId, { networkAccess: true }),
      ).rejects.toThrow('pull failed: network error')
    })
  })
})
