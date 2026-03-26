import { describe, it, expect } from 'vitest'
import {
  createMockPrisma,
  createMockAgentService,
  createMockToolExecutorService,
  createMockChatService,
  createMockSandboxService,
  createMockBrowserService,
  createMockSettingsService,
  createMockCapabilityService,
  createMockPermissionService,
  createMockLLMProvider,
  createMockSSEStream,
  createMockSSEEmit,
  sessionEvent,
  contentEvent,
  toolStartEvent,
  toolResultEvent,
  doneEvent,
  errorEvent,
  thinkingEvent,
} from '@test/factories'

describe('Mock Factories', () => {
  describe('createMockPrisma', () => {
    it('creates a mock prisma client with all expected models', () => {
      const prisma = createMockPrisma()
      expect(prisma.chatSession).toBeDefined()
      expect(prisma.chatMessage).toBeDefined()
      expect(prisma.workspace).toBeDefined()
      expect(prisma.document).toBeDefined()
      expect(prisma.documentChunk).toBeDefined()
      expect(prisma.capability).toBeDefined()
      expect(prisma.workspaceCapability).toBeDefined()
      expect(prisma.toolExecution).toBeDefined()
      expect(prisma.appSettings).toBeDefined()
      expect(prisma.sandboxSession).toBeDefined()
      expect(prisma.tokenUsage).toBeDefined()
      expect(prisma.cronJob).toBeDefined()
      expect(prisma.$transaction).toBeDefined()
      expect(prisma.$queryRaw).toBeDefined()
      expect(prisma.$executeRaw).toBeDefined()
    })

    it('findMany returns empty arrays by default', async () => {
      const prisma = createMockPrisma()
      expect(await prisma.chatSession.findMany()).toEqual([])
      expect(await prisma.chatMessage.findMany()).toEqual([])
    })

    it('findUnique returns null by default', async () => {
      const prisma = createMockPrisma()
      expect(await prisma.chatSession.findUnique()).toBeNull()
    })

    it('$transaction executes callback', async () => {
      const prisma = createMockPrisma()
      const result = await prisma.$transaction(async (tx: unknown) => {
        return 'done'
      })
      expect(result).toBe('done')
    })
  })

  describe('Service mock factories', () => {
    it('createMockAgentService has runAgentLoop', async () => {
      const svc = createMockAgentService()
      const result = await svc.runAgentLoop()
      expect(result).toHaveProperty('lastMessageId')
      expect(result).toHaveProperty('paused', false)
    })

    it('createMockToolExecutorService has execute', async () => {
      const svc = createMockToolExecutorService()
      const result = await svc.execute()
      expect(result).toHaveProperty('output')
      expect(result).toHaveProperty('durationMs')
    })

    it('createMockChatService has all methods', () => {
      const svc = createMockChatService()
      expect(svc.createSession).toBeDefined()
      expect(svc.listSessions).toBeDefined()
      expect(svc.getSession).toBeDefined()
      expect(svc.sendMessage).toBeDefined()
      expect(svc.deleteSession).toBeDefined()
      expect(svc.getMessages).toBeDefined()
    })

    it('createMockSandboxService has all methods', () => {
      const svc = createMockSandboxService()
      expect(svc.getOrCreateWorkspaceContainer).toBeDefined()
      expect(svc.execInWorkspace).toBeDefined()
      expect(svc.destroySandbox).toBeDefined()
      expect(svc.stopWorkspaceContainer).toBeDefined()
    })

    it('createMockBrowserService has all methods', () => {
      const svc = createMockBrowserService()
      expect(svc.healthCheck).toBeDefined()
      expect(svc.executeScript).toBeDefined()
      expect(svc.closeSession).toBeDefined()
    })

    it('createMockSettingsService has all methods', () => {
      const svc = createMockSettingsService()
      expect(svc.get).toBeDefined()
      expect(svc.getAIProvider).toBeDefined()
      expect(svc.update).toBeDefined()
    })

    it('createMockCapabilityService has all methods', () => {
      const svc = createMockCapabilityService()
      expect(svc.getEnabledCapabilitiesForWorkspace).toBeDefined()
      expect(svc.buildToolDefinitions).toBeDefined()
      expect(svc.buildSystemPrompt).toBeDefined()
    })

    it('createMockPermissionService has isToolAllowed', () => {
      const svc = createMockPermissionService()
      expect(svc.isToolAllowed()).toBe(true)
    })
  })

  describe('createMockLLMProvider', () => {
    it('returns default response', async () => {
      const llm = createMockLLMProvider()
      const result = await llm.chatWithTools([])
      expect(result.content).toBe('Mock LLM response')
      expect(result.finishReason).toBe('stop')
      expect(result.usage).toBeDefined()
    })

    it('supports custom response content', async () => {
      const llm = createMockLLMProvider({ response: { content: 'Hello world' } })
      const result = await llm.chatWithTools([])
      expect(result.content).toBe('Hello world')
    })

    it('supports tool call responses', async () => {
      const llm = createMockLLMProvider({
        response: {
          content: '',
          toolCalls: [{ id: 'tc1', name: 'run_bash', arguments: { command: 'ls' } }],
          finishReason: 'tool_calls',
        },
      })
      const result = await llm.chatWithTools([])
      expect(result.toolCalls).toHaveLength(1)
      expect(result.finishReason).toBe('tool_calls')
    })

    it('supports error simulation', async () => {
      const llm = createMockLLMProvider({ error: new Error('Rate limited') })
      await expect(llm.chatWithTools([])).rejects.toThrow('Rate limited')
      await expect(llm.chat([])).rejects.toThrow('Rate limited')
    })

    it('has correct modelId and providerId', () => {
      const llm = createMockLLMProvider({ modelId: 'gpt-4o', providerId: 'openai' })
      expect(llm.modelId).toBe('gpt-4o')
      expect(llm.providerId).toBe('openai')
    })
  })

  describe('SSE helpers', () => {
    it('createMockSSEStream produces valid SSE response', async () => {
      const response = createMockSSEStream([
        sessionEvent('s1'),
        contentEvent('Hello'),
        doneEvent({ sessionId: 's1', messageId: 'm1' }),
      ])
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('text/event-stream')

      const text = await response.text()
      expect(text).toContain('event: session')
      expect(text).toContain('event: content')
      expect(text).toContain('event: done')
      expect(text).toContain('"Hello"')
    })

    it('createMockSSEEmit records events', () => {
      const { emit, events } = createMockSSEEmit()
      emit('content', { text: 'hi' })
      emit('done', { sessionId: 's1' })
      expect(events).toHaveLength(2)
      expect(events[0]).toEqual({ event: 'content', data: { text: 'hi' } })
    })

    it('event builders produce correct shapes', () => {
      expect(sessionEvent()).toEqual({ event: 'session', data: { sessionId: 'mock-session-id' } })
      expect(contentEvent('hi')).toEqual({ event: 'content', data: { text: 'hi' } })
      expect(thinkingEvent()).toEqual({ event: 'thinking', data: { message: 'Thinking...' } })
      expect(errorEvent('oops')).toEqual({ event: 'error', data: { message: 'oops' } })

      const ts = toolStartEvent('run_bash', { input: { command: 'ls' } })
      expect(ts.event).toBe('tool_start')
      expect(ts.data.toolName).toBe('run_bash')

      const tr = toolResultEvent('run_bash', { output: 'files', exitCode: 0 })
      expect(tr.event).toBe('tool_result')
      expect(tr.data.output).toBe('files')

      const d = doneEvent({ messageId: 'm1' })
      expect(d.event).toBe('done')
      expect(d.data.messageId).toBe('m1')
    })
  })
})
