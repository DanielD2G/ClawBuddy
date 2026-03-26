import { describe, expect, test, vi, beforeEach } from 'vitest'
import { createMockPrisma, type MockPrisma } from '@test/factories/prisma'

// ── Mocks ───────────────────────────────────────────────────────────────

let mockPrisma: MockPrisma

vi.mock('../../lib/prisma.js', () => ({
  get prisma() {
    return mockPrisma
  },
}))

vi.mock('../sandbox.service.js', () => ({
  sandboxService: {
    execInWorkspace: vi.fn(),
  },
}))

vi.mock('../../lib/sanitize.js', () => ({
  stripNullBytes: vi.fn().mockImplementation((s: string) => s),
}))

import { executeSandboxCommand } from './sandbox.handler.js'
import { sandboxService } from '../sandbox.service.js'
import type { ExecutionContext } from './handler-utils.js'

const baseContext: ExecutionContext = {
  workspaceId: 'ws-1',
  chatSessionId: 'session-1',
}

describe('executeSandboxCommand', () => {
  beforeEach(() => {
    mockPrisma = createMockPrisma()
    vi.clearAllMocks()
  })

  // ── No workspace ─────────────────────────────────────────────────────

  test('returns error when no workspaceId is available', async () => {
    const toolCall = { id: 'tc-1', name: 'run_bash', arguments: { command: 'ls' } }
    const result = await executeSandboxCommand(toolCall, 'cap-slug', {
      ...baseContext,
      workspaceId: '',
    })

    expect(result.error).toContain('No workspace context available')
    expect(sandboxService.execInWorkspace).not.toHaveBeenCalled()
  })

  // ── run_bash ─────────────────────────────────────────────────────────

  test('executes bash command successfully', async () => {
    vi.mocked(sandboxService.execInWorkspace).mockResolvedValue({
      stdout: 'file1.txt\nfile2.txt',
      stderr: '',
      exitCode: 0,
    })

    const toolCall = { id: 'tc-1', name: 'run_bash', arguments: { command: 'ls' } }
    const result = await executeSandboxCommand(toolCall, 'cap-slug', baseContext)

    expect(sandboxService.execInWorkspace).toHaveBeenCalledWith('ws-1', 'ls', {
      timeout: 30,
      workingDir: '/workspace',
    })
    expect(result.output).toContain('file1.txt')
    expect(result.exitCode).toBe(0)
    expect(result.error).toBeUndefined()
  })

  test('reports error on non-zero exit code', async () => {
    vi.mocked(sandboxService.execInWorkspace).mockResolvedValue({
      stdout: '',
      stderr: 'command not found',
      exitCode: 127,
    })

    const toolCall = { id: 'tc-1', name: 'run_bash', arguments: { command: 'notacommand' } }
    const result = await executeSandboxCommand(toolCall, 'cap-slug', baseContext)

    expect(result.exitCode).toBe(127)
    expect(result.error).toBe('command not found')
  })

  test('uses custom timeout and workingDir from args', async () => {
    vi.mocked(sandboxService.execInWorkspace).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
    })

    const toolCall = {
      id: 'tc-1',
      name: 'run_bash',
      arguments: { command: 'pwd', timeout: 60, workingDir: '/tmp' },
    }
    await executeSandboxCommand(toolCall, 'cap-slug', baseContext)

    expect(sandboxService.execInWorkspace).toHaveBeenCalledWith('ws-1', 'pwd', {
      timeout: 60,
      workingDir: '/tmp',
    })
  })

  // ── run_python ───────────────────────────────────────────────────────

  test('executes python script via base64 encoding', async () => {
    vi.mocked(sandboxService.execInWorkspace).mockResolvedValue({
      stdout: 'Hello from Python',
      stderr: '',
      exitCode: 0,
    })

    const code = 'print("Hello from Python")'
    const toolCall = { id: 'tc-1', name: 'run_python', arguments: { code } }
    await executeSandboxCommand(toolCall, 'cap-slug', baseContext)

    const calledCommand = vi.mocked(sandboxService.execInWorkspace).mock.calls[0][1] as string
    expect(calledCommand).toContain('python3')
    expect(calledCommand).toContain('base64')
    // Verify the base64 roundtrips
    const b64Part = calledCommand.match(/echo '([^']+)'/)?.[1]
    expect(b64Part).toBeTruthy()
    expect(Buffer.from(b64Part!, 'base64').toString('utf-8')).toBe(code)
  })

  // ── run_js ───────────────────────────────────────────────────────────

  test('executes javascript via base64 encoding', async () => {
    vi.mocked(sandboxService.execInWorkspace).mockResolvedValue({
      stdout: '42',
      stderr: '',
      exitCode: 0,
    })

    const code = 'console.log(42)'
    const toolCall = { id: 'tc-1', name: 'run_js', arguments: { code } }
    await executeSandboxCommand(toolCall, 'cap-slug', baseContext)

    const calledCommand = vi.mocked(sandboxService.execInWorkspace).mock.calls[0][1] as string
    expect(calledCommand).toContain('node')
    expect(calledCommand).toContain('base64')
  })

  // ── Dynamic skill tool ───────────────────────────────────────────────

  test('resolves skill command from preloaded capability data', async () => {
    vi.mocked(sandboxService.execInWorkspace).mockResolvedValue({
      stdout: 'skill output',
      stderr: '',
      exitCode: 0,
    })

    const toolCall = {
      id: 'tc-1',
      name: 'my_skill_tool',
      arguments: { command: 'do stuff' },
    }
    const context: ExecutionContext = {
      ...baseContext,
      capability: {
        slug: 'my-skill',
        skillType: 'bash',
        toolDefinitions: [{ name: 'my_skill_tool' }],
      },
    }

    const result = await executeSandboxCommand(toolCall, 'my-skill', context)

    expect(result.output).toContain('skill output')
    expect(result.exitCode).toBe(0)
  })

  test('returns error for unsupported sandbox tool when skill resolution fails', async () => {
    const toolCall = { id: 'tc-1', name: 'unknown_tool_xyz', arguments: {} }
    const context: ExecutionContext = {
      ...baseContext,
      capability: {
        slug: 'some-cap',
        skillType: null,
        toolDefinitions: [],
      },
    }

    const result = await executeSandboxCommand(toolCall, 'some-cap', context)

    expect(result.error).toContain('Unsupported sandbox tool: unknown_tool_xyz')
    expect(sandboxService.execInWorkspace).not.toHaveBeenCalled()
  })

  test('resolves python skill type with base64 encoding', async () => {
    vi.mocked(sandboxService.execInWorkspace).mockResolvedValue({
      stdout: 'py output',
      stderr: '',
      exitCode: 0,
    })

    const toolCall = { id: 'tc-1', name: 'py_tool', arguments: { code: 'print(1)' } }
    const context: ExecutionContext = {
      ...baseContext,
      capability: {
        slug: 'py-cap',
        skillType: 'python',
        toolDefinitions: [{ name: 'py_tool' }],
      },
    }

    await executeSandboxCommand(toolCall, 'py-cap', context)

    const calledCommand = vi.mocked(sandboxService.execInWorkspace).mock.calls[0][1] as string
    expect(calledCommand).toContain('python3')
  })

  test('resolves skill with script property', async () => {
    vi.mocked(sandboxService.execInWorkspace).mockResolvedValue({
      stdout: 'script output',
      stderr: '',
      exitCode: 0,
    })

    const toolCall = {
      id: 'tc-1',
      name: 'scripted_tool',
      arguments: { input: 'hello' },
    }
    const context: ExecutionContext = {
      ...baseContext,
      capability: {
        slug: 'script-cap',
        skillType: 'python',
        toolDefinitions: [
          {
            name: 'scripted_tool',
            script: 'import sys\nprint(sys.argv[1])',
            parameters: { required: ['input'] },
          },
        ],
      },
    }

    await executeSandboxCommand(toolCall, 'script-cap', context)

    const calledCommand = vi.mocked(sandboxService.execInWorkspace).mock.calls[0][1] as string
    expect(calledCommand).toContain('_skill_scripted_tool.py')
    expect(calledCommand).toContain('python3')
    expect(calledCommand).toContain('"hello"')
  })

  // ── Output formatting ────────────────────────────────────────────────

  test('formats output with stdout, stderr, and exit code', async () => {
    vi.mocked(sandboxService.execInWorkspace).mockResolvedValue({
      stdout: 'out',
      stderr: 'err',
      exitCode: 1,
    })

    const toolCall = { id: 'tc-1', name: 'run_bash', arguments: { command: 'fail' } }
    const result = await executeSandboxCommand(toolCall, 'cap-slug', baseContext)

    expect(result.output).toContain('stdout:\nout')
    expect(result.output).toContain('stderr:\nerr')
    expect(result.output).toContain('exit code: 1')
  })

  test('omits empty stdout/stderr sections', async () => {
    vi.mocked(sandboxService.execInWorkspace).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
    })

    const toolCall = { id: 'tc-1', name: 'run_bash', arguments: { command: 'true' } }
    const result = await executeSandboxCommand(toolCall, 'cap-slug', baseContext)

    expect(result.output).not.toContain('stdout:')
    expect(result.output).not.toContain('stderr:')
    expect(result.output).toContain('exit code: 0')
  })

  test('provides fallback error message when stderr is empty on failure', async () => {
    vi.mocked(sandboxService.execInWorkspace).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 2,
    })

    const toolCall = { id: 'tc-1', name: 'run_bash', arguments: { command: 'exit 2' } }
    const result = await executeSandboxCommand(toolCall, 'cap-slug', baseContext)

    expect(result.error).toBe('Command failed with exit code 2')
  })
})
