import { describe, expect, test, vi, beforeEach } from 'vitest'

// ── Mocks ───────────────────────────────────────────────────────────────

vi.mock('../browser.service.js', () => ({
  browserService: {
    executeScript: vi.fn(),
    closeSession: vi.fn(),
  },
}))

vi.mock('../sandbox.service.js', () => ({
  sandboxService: {
    writeFileToContainer: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../../lib/screenshot.js', () => ({
  extractScreenshotBase64: vi.fn().mockReturnValue({ screenshotB64: null, description: null }),
}))

import { executeBrowserScript } from './browser.handler.js'
import { browserService } from '../browser.service.js'
import { sandboxService } from '../sandbox.service.js'
import type { ExecutionContext } from './handler-utils.js'

const baseContext: ExecutionContext = {
  workspaceId: 'ws-1',
  chatSessionId: 'session-1',
}

describe('executeBrowserScript', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('executes script successfully and returns output', async () => {
    vi.mocked(browserService.executeScript).mockResolvedValue({
      success: true,
      result: 'Hello world',
    })

    const toolCall = {
      id: 'tc-1',
      name: 'run_browser_script',
      arguments: { script: 'console.log("hi")' },
    }
    const result = await executeBrowserScript(toolCall, baseContext)

    expect(browserService.executeScript).toHaveBeenCalledWith('session-1', 'console.log("hi")', 30)
    expect(result.output).toBe('Hello world')
    expect(result.error).toBeUndefined()
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('returns error when script is empty', async () => {
    const toolCall = { id: 'tc-1', name: 'run_browser_script', arguments: { script: '' } }
    const result = await executeBrowserScript(toolCall, baseContext)

    expect(result.error).toBe('Script is required')
    expect(browserService.executeScript).not.toHaveBeenCalled()
  })

  test('uses browserSessionId when provided in context', async () => {
    vi.mocked(browserService.executeScript).mockResolvedValue({
      success: true,
      result: 'done',
    })

    const toolCall = {
      id: 'tc-1',
      name: 'run_browser_script',
      arguments: { script: 'x', timeout: 60 },
    }
    await executeBrowserScript(toolCall, { ...baseContext, browserSessionId: 'custom-session' })

    expect(browserService.executeScript).toHaveBeenCalledWith('custom-session', 'x', 60)
  })

  test('clamps timeout between 5 and 120 seconds', async () => {
    vi.mocked(browserService.executeScript).mockResolvedValue({ success: true, result: 'ok' })

    // Too low
    const toolCall1 = {
      id: 'tc-1',
      name: 'run_browser_script',
      arguments: { script: 'x', timeout: 1 },
    }
    await executeBrowserScript(toolCall1, baseContext)
    expect(browserService.executeScript).toHaveBeenCalledWith('session-1', 'x', 5)

    // Too high
    const toolCall2 = {
      id: 'tc-2',
      name: 'run_browser_script',
      arguments: { script: 'x', timeout: 999 },
    }
    await executeBrowserScript(toolCall2, baseContext)
    expect(browserService.executeScript).toHaveBeenCalledWith('session-1', 'x', 120)
  })

  test('returns error output with screenshot on failure', async () => {
    vi.mocked(browserService.executeScript).mockResolvedValue({
      success: false,
      error: 'Element not found',
      screenshotBase64: 'scr-b64-data',
    })

    const toolCall = {
      id: 'tc-1',
      name: 'run_browser_script',
      arguments: { script: 'click("#missing")' },
    }
    const result = await executeBrowserScript(toolCall, baseContext)

    expect(result.error).toBe('Element not found')
    const parsed = JSON.parse(result.output)
    expect(parsed.error).toBe('Element not found')
    expect(parsed.screenshot).toBe('scr-b64-data')
  })

  test('returns error output without screenshot on failure', async () => {
    vi.mocked(browserService.executeScript).mockResolvedValue({
      success: false,
      error: 'Timeout exceeded',
    })

    const toolCall = {
      id: 'tc-1',
      name: 'run_browser_script',
      arguments: { script: 'wait(999)' },
    }
    const result = await executeBrowserScript(toolCall, baseContext)

    expect(result.error).toBe('Timeout exceeded')
    expect(result.output).toBe('Error: Timeout exceeded')
  })

  test('handles __saveScreenshot flow successfully', async () => {
    vi.mocked(browserService.executeScript).mockResolvedValue({
      success: true,
      result: JSON.stringify({
        __saveScreenshot: true,
        screenshot: 'img-b64',
        filename: 'page.jpg',
      }),
    })
    vi.mocked(sandboxService.writeFileToContainer).mockResolvedValue(undefined)

    const toolCall = {
      id: 'tc-1',
      name: 'run_browser_script',
      arguments: { script: 'saveScreenshot()' },
    }
    const result = await executeBrowserScript(toolCall, baseContext)

    expect(sandboxService.writeFileToContainer).toHaveBeenCalled()
    const parsed = JSON.parse(result.output)
    expect(parsed.savedPath).toMatch(/\/workspace\/screenshots\/page-.*\.jpg/)
    expect(parsed.__saveScreenshot).toBeUndefined()
    expect(parsed.screenshot).toBeUndefined()
  })

  test('__saveScreenshot fails when no workspaceId', async () => {
    vi.mocked(browserService.executeScript).mockResolvedValue({
      success: true,
      result: JSON.stringify({ __saveScreenshot: true, screenshot: 'img' }),
    })

    const toolCall = {
      id: 'tc-1',
      name: 'run_browser_script',
      arguments: { script: 'x' },
    }
    const result = await executeBrowserScript(toolCall, {
      ...baseContext,
      workspaceId: '',
    })

    expect(result.error).toBe('saveScreenshot() requires an active sandbox session.')
  })

  test('defaults to Script completed when result is null', async () => {
    vi.mocked(browserService.executeScript).mockResolvedValue({
      success: true,
      result: null,
    })

    const toolCall = {
      id: 'tc-1',
      name: 'run_browser_script',
      arguments: { script: 'void 0' },
    }
    const result = await executeBrowserScript(toolCall, baseContext)

    expect(result.output).toBe('Script completed.')
  })
})
