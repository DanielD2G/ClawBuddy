import { describe, expect, test } from 'bun:test'
import { maybeTruncateOutput } from './agent-tool-results.service.js'
import { sandboxService } from './sandbox.service.js'

describe('maybeTruncateOutput', () => {
  test('instructs the model to use read_file first for truncated outputs', async () => {
    const originalExecInWorkspace = sandboxService.execInWorkspace
    sandboxService.execInWorkspace = async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    })

    const output = 'x'.repeat(25_000)
    try {
      const result = await maybeTruncateOutput(output, 'test-tool-call', 'workspace-under-test')

      expect(result).toContain('saved to /workspace/.outputs/test-tool-call.txt')
      expect(result).toContain(
        'inspect /workspace/.outputs/test-tool-call.txt with read_file first',
      )
      expect(result).toContain('Only use bash or python if you need advanced processing')
      expect(result).not.toContain('use jq, grep, awk, head, or python')
    } finally {
      sandboxService.execInWorkspace = originalExecInWorkspace
    }
  })
})
