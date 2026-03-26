import { describe, expect, test, vi, beforeEach } from 'vitest'

// ── Mocks ───────────────────────────────────────────────────────────────

const mockLLM = {
  providerId: 'mock-provider',
  modelId: 'mock-model',
  chatWithTools: vi.fn().mockResolvedValue({
    content: 'Sub-agent result',
    toolCalls: [],
    finishReason: 'stop',
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  }),
}

vi.mock('../providers/index.js', () => ({
  createExploreLLM: vi.fn().mockImplementation(() => Promise.resolve(mockLLM)),
  createExecuteLLM: vi.fn().mockImplementation(() => Promise.resolve(mockLLM)),
  createLightLLM: vi.fn().mockImplementation(() => Promise.resolve(mockLLM)),
  createLLMProvider: vi.fn().mockImplementation(() => Promise.resolve(mockLLM)),
}))

vi.mock('./capability.service.js', () => ({
  capabilityService: {
    getEnabledCapabilitiesForWorkspace: vi.fn().mockResolvedValue([
      {
        slug: 'test-cap',
        name: 'Test',
        systemPrompt: 'Use test tools',
        toolDefinitions: [
          { name: 'run_bash', description: 'Run bash', parameters: {} },
          { name: 'web_search', description: 'Search', parameters: {} },
          { name: 'search_documents', description: 'Search docs', parameters: {} },
        ],
        skillType: null,
      },
    ]),
    buildToolDefinitions: vi.fn().mockReturnValue([
      { name: 'run_bash', description: 'Run bash', inputSchema: {} },
      { name: 'web_search', description: 'Search', inputSchema: {} },
      { name: 'search_documents', description: 'Search docs', inputSchema: {} },
      { name: 'delegate_task', description: 'Delegate', inputSchema: {} },
    ]),
  },
}))

vi.mock('./settings.service.js', () => ({
  settingsService: {
    getSubAgentExploreMaxIterations: vi.fn().mockResolvedValue(10),
    getSubAgentAnalyzeMaxIterations: vi.fn().mockResolvedValue(10),
    getSubAgentExecuteMaxIterations: vi.fn().mockResolvedValue(15),
  },
}))

vi.mock('./tool-executor.service.js', () => ({
  toolExecutorService: {
    execute: vi.fn().mockResolvedValue({
      output: 'tool output',
      durationMs: 100,
    }),
  },
}))

vi.mock('./secret-redaction.service.js', () => ({
  secretRedactionService: {
    redactForPublicStorage: vi.fn().mockImplementation((args: unknown) => args),
  },
}))

vi.mock('./agent-token.service.js', () => ({
  recordTokenUsage: vi.fn(),
  checkToolArgSize: vi.fn().mockReturnValue(null),
}))

vi.mock('../lib/llm-retry.js', () => ({
  retryProviderTimeoutOnce: vi.fn().mockImplementation((fn: () => unknown) => fn()),
}))

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../constants.js', () => ({
  OUTPUT_TRUNCATE_THRESHOLD: 10000,
  PARALLEL_SAFE_TOOLS: new Set(['web_search', 'search_documents']),
}))

import { subAgentService, filterTools } from './sub-agent.service.js'
import type { SubAgentRoleConfig } from './sub-agent.types.js'

describe('sub-agent.service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLLM.chatWithTools.mockResolvedValue({
      content: 'Sub-agent result',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    })
  })

  const baseContext = {
    workspaceId: 'ws-1',
    sessionId: 'sess-1',
    secretInventory: { secrets: [], patterns: [] },
  }

  // ── filterTools ───────────────────────────────────────────────────────

  describe('filterTools', () => {
    const allTools = [
      { name: 'run_bash', description: 'Run bash', inputSchema: {} },
      { name: 'web_search', description: 'Search', inputSchema: {} },
      { name: 'delegate_task', description: 'Delegate', inputSchema: {} },
    ] as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>

    test('filters to allowed tool list', () => {
      const config: SubAgentRoleConfig = {
        role: 'explore',
        description: 'test',
        modelTier: 'explore',
        readOnly: true,
        allowedTools: ['run_bash', 'web_search'],
      }
      const result = filterTools(allTools, config)
      expect(result).toHaveLength(2)
      expect(result.map((t) => t.name)).toEqual(['run_bash', 'web_search'])
    })

    test('allows all tools except denied ones when allowedTools is "all"', () => {
      const config: SubAgentRoleConfig = {
        role: 'execute',
        description: 'test',
        modelTier: 'execute',
        readOnly: false,
        allowedTools: 'all',
        deniedTools: ['delegate_task'],
      }
      const result = filterTools(allTools, config)
      expect(result).toHaveLength(2)
      expect(result.map((t) => t.name)).not.toContain('delegate_task')
    })

    test('allows all tools when no denied list', () => {
      const config: SubAgentRoleConfig = {
        role: 'execute',
        description: 'test',
        modelTier: 'execute',
        readOnly: false,
        allowedTools: 'all',
      }
      const result = filterTools(allTools, config)
      expect(result).toHaveLength(3)
    })

    test('returns empty array when allowed list has no matches', () => {
      const config: SubAgentRoleConfig = {
        role: 'explore',
        description: 'test',
        modelTier: 'explore',
        readOnly: true,
        allowedTools: ['nonexistent_tool'],
      }
      const result = filterTools(allTools, config)
      expect(result).toEqual([])
    })
  })

  // ── runSubAgent ───────────────────────────────────────────────────────

  describe('runSubAgent', () => {
    test('returns error for unknown role', async () => {
      const result = await subAgentService.runSubAgent(
        { role: 'unknown' as 'explore', task: 'test' },
        baseContext,
      )
      expect(result.success).toBe(false)
      expect(result.result).toContain('Unknown sub-agent role')
    })

    test('runs explore sub-agent successfully', async () => {
      const result = await subAgentService.runSubAgent(
        { role: 'explore', task: 'Find information about X' },
        baseContext,
      )
      expect(result.success).toBe(true)
      expect(result.result).toBe('Sub-agent result')
      expect(result.role).toBe('explore')
      expect(result.iterationsUsed).toBe(1)
    })

    test('returns failure when no tools are available', async () => {
      const { capabilityService } = await import('./capability.service.js')
      vi.mocked(capabilityService.buildToolDefinitions).mockReturnValueOnce([])

      const result = await subAgentService.runSubAgent(
        { role: 'explore', task: 'test' },
        baseContext,
      )
      expect(result.success).toBe(false)
      expect(result.result).toContain('No tools available')
    })

    test('executes tool calls and continues the loop', async () => {
      // First response has tool calls, second response is done
      mockLLM.chatWithTools
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [{ id: 'tc1', name: 'run_bash', arguments: { command: 'ls' } }],
          finishReason: 'tool_calls',
          usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
        })
        .mockResolvedValueOnce({
          content: 'Done with task',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110 },
        })

      const result = await subAgentService.runSubAgent(
        { role: 'execute', task: 'Run ls and report' },
        baseContext,
      )

      expect(result.success).toBe(true)
      expect(result.result).toBe('Done with task')
      expect(result.iterationsUsed).toBe(2)
      expect(result.toolExecutions).toHaveLength(1)
      expect(result.toolExecutions[0].toolName).toBe('run_bash')
    })

    test('emits SSE events when emit function provided', async () => {
      const emit = vi.fn()

      await subAgentService.runSubAgent({ role: 'explore', task: 'test' }, { ...baseContext, emit })

      expect(emit).toHaveBeenCalledWith('sub_agent_start', expect.any(Object))
      expect(emit).toHaveBeenCalledWith('thinking', expect.any(Object))
      expect(emit).toHaveBeenCalledWith('sub_agent_done', expect.any(Object))
    })

    test('respects abort signal', async () => {
      const controller = new AbortController()
      controller.abort()

      const result = await subAgentService.runSubAgent(
        { role: 'explore', task: 'test' },
        { ...baseContext, signal: controller.signal },
      )

      // Should exit early; the LLM won't be called because loop is aborted before first iteration
      expect(result.success).toBe(false)
      expect(result.result).toContain('reached maximum iterations')
    })

    test('returns failure when max iterations exhausted', async () => {
      // Always return tool calls so the loop never finishes
      mockLLM.chatWithTools.mockResolvedValue({
        content: '',
        toolCalls: [{ id: 'tc1', name: 'run_bash', arguments: { command: 'ls' } }],
        finishReason: 'tool_calls',
        usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
      })

      const result = await subAgentService.runSubAgent(
        { role: 'explore', task: 'infinite loop test' },
        baseContext,
      )

      expect(result.success).toBe(false)
      expect(result.result).toContain('reached maximum iterations')
      expect(result.iterationsUsed).toBe(10) // explore max iterations
    })

    test('accumulates token usage across iterations', async () => {
      mockLLM.chatWithTools
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [{ id: 'tc1', name: 'run_bash', arguments: { command: 'ls' } }],
          finishReason: 'tool_calls',
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        })
        .mockResolvedValueOnce({
          content: 'Done',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
        })

      const result = await subAgentService.runSubAgent(
        { role: 'execute', task: 'test' },
        baseContext,
      )

      expect(result.tokenUsage).toEqual({
        inputTokens: 300,
        outputTokens: 150,
        totalTokens: 450,
      })
    })

    test('uses pre-loaded capabilities from parent context', async () => {
      const { capabilityService } = await import('./capability.service.js')
      const preloaded = [
        {
          slug: 'preloaded',
          name: 'Preloaded',
          systemPrompt: 'preloaded prompt',
          toolDefinitions: [{ name: 'run_bash', description: 'Run', parameters: {} }],
          skillType: null,
        },
      ]

      await subAgentService.runSubAgent(
        { role: 'explore', task: 'test' },
        { ...baseContext, capabilities: preloaded },
      )

      expect(capabilityService.getEnabledCapabilitiesForWorkspace).not.toHaveBeenCalled()
    })
  })

  // ── executeSubAgentTool ───────────────────────────────────────────────

  describe('executeSubAgentTool', () => {
    const capabilities = [
      {
        slug: 'test-cap',
        toolDefinitions: [{ name: 'run_bash' }],
        skillType: null,
      },
    ]
    const roleConfig: SubAgentRoleConfig = {
      role: 'explore',
      description: 'test',
      modelTier: 'explore',
      readOnly: true,
      allowedTools: ['run_bash'],
    }

    test('executes a tool and returns result', async () => {
      const result = await subAgentService.executeSubAgentTool(
        { id: 'tc1', name: 'run_bash', arguments: { command: 'ls' } },
        capabilities,
        baseContext,
        roleConfig,
      )

      expect(result.capabilitySlug).toBe('test-cap')
      expect(result.result.output).toBe('tool output')
    })

    test('rejects oversized tool arguments', async () => {
      const { checkToolArgSize } = await import('./agent-token.service.js')
      vi.mocked(checkToolArgSize).mockReturnValueOnce('Argument too large')

      const emit = vi.fn()
      const result = await subAgentService.executeSubAgentTool(
        { id: 'tc1', name: 'run_bash', arguments: { command: 'x'.repeat(100000) } },
        capabilities,
        baseContext,
        roleConfig,
        emit,
      )

      expect(result.result.error).toBe('Argument too large')
      expect(emit).toHaveBeenCalledWith(
        'tool_result',
        expect.objectContaining({ error: 'Argument too large' }),
      )
    })

    test('returns unknown capability slug for unmatched tool', async () => {
      const result = await subAgentService.executeSubAgentTool(
        { id: 'tc1', name: 'unknown_tool', arguments: {} },
        capabilities,
        baseContext,
        roleConfig,
      )

      expect(result.capabilitySlug).toBe('unknown')
    })
  })
})
