import { describe, expect, test, vi } from 'vitest'

vi.mock('../lib/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('./secret-redaction.service.js', () => ({
  secretRedactionService: {
    redactForPublicStorage: vi.fn().mockImplementation((v: unknown) => v),
  },
}))

// Use real crypto for round-trip tests
import {
  serializeEncryptedAgentState,
  deserializeAgentState,
  buildPublicAgentState,
} from './agent-state.service.js'
import type { AgentState } from './agent-state.service.js'

// ── Helpers ─────────────────────────────────────────────────────────────

function createTestAgentState(overrides?: Partial<AgentState>): AgentState {
  return {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
    ],
    iteration: 2,
    pendingToolCalls: [{ id: 'tc-1', name: 'run_bash', arguments: { command: 'ls' } }],
    completedToolResults: [{ toolCallId: 'tc-0', content: 'file1.txt' }],
    toolExecutionLog: [
      {
        toolName: 'run_bash',
        capabilitySlug: 'shell',
        input: { command: 'ls' },
        output: 'file1.txt',
        durationMs: 100,
      },
    ],
    workspaceId: 'ws-1',
    sessionId: 'session-1',
    discoveredCapabilitySlugs: ['web-search'],
    mentionedSlugs: ['web-search'],
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('serializeEncryptedAgentState / deserializeAgentState', () => {
  test('round-trip: serialize then deserialize returns same state', () => {
    const state = createTestAgentState()
    const encrypted = serializeEncryptedAgentState(state)

    expect(typeof encrypted).toBe('string')
    expect(encrypted.length).toBeGreaterThan(0)

    const restored = deserializeAgentState({
      agentState: null,
      agentStateEncrypted: encrypted,
    })

    expect(restored).toEqual(state)
  })

  test('serialized output is a non-empty encrypted string', () => {
    const state = createTestAgentState()
    const encrypted = serializeEncryptedAgentState(state)
    // Encrypted format is iv:tag:data (three colon-separated base64 parts)
    expect(encrypted.split(':').length).toBe(3)
  })

  test('handles state with empty arrays', () => {
    const state = createTestAgentState({
      messages: [],
      pendingToolCalls: [],
      completedToolResults: [],
      toolExecutionLog: [],
    })

    const encrypted = serializeEncryptedAgentState(state)
    const restored = deserializeAgentState({
      agentState: null,
      agentStateEncrypted: encrypted,
    })
    expect(restored).toEqual(state)
  })

  test('handles state with special characters in messages', () => {
    const state = createTestAgentState({
      messages: [{ role: 'user', content: '¡Hola! éàü ñ 日本語 🎉 "quotes" & <tags>' }],
    })

    const encrypted = serializeEncryptedAgentState(state)
    const restored = deserializeAgentState({
      agentState: null,
      agentStateEncrypted: encrypted,
    })
    expect(restored).toEqual(state)
  })
})

describe('deserializeAgentState', () => {
  test('falls back to legacy agentState when encrypted is null', () => {
    const state = createTestAgentState()
    const restored = deserializeAgentState({
      agentState: state as unknown as null,
      agentStateEncrypted: null,
    })
    expect(restored).toEqual(state)
  })

  test('returns null when both fields are null', () => {
    const restored = deserializeAgentState({
      agentState: null,
      agentStateEncrypted: null,
    })
    expect(restored).toBeNull()
  })

  test('falls back to legacy format when encrypted state is corrupted', () => {
    const state = createTestAgentState()
    const restored = deserializeAgentState({
      agentState: state as unknown as null,
      agentStateEncrypted: 'invalid:encrypted:data',
    })
    // Should fall back to agentState
    expect(restored).toEqual(state)
  })

  test('returns null when encrypted is corrupted and agentState is also null', () => {
    const restored = deserializeAgentState({
      agentState: null,
      agentStateEncrypted: 'corrupted-garbage',
    })
    expect(restored).toBeNull()
  })
})

describe('buildPublicAgentState', () => {
  test('filters sensitive data and returns public fields', () => {
    const state = createTestAgentState()
    const inventory = {
      enabled: false,
      secretValues: [],
      secretPattern: null,
      aliases: [],
      references: [],
    } as never
    const publicState = buildPublicAgentState(state, inventory)

    expect(publicState).toHaveProperty('iteration', 2)
    expect(publicState).toHaveProperty('workspaceId', 'ws-1')
    expect(publicState).toHaveProperty('sessionId', 'session-1')
    expect(publicState).toHaveProperty('pendingToolCalls')
    expect(publicState.pendingToolCalls).toHaveLength(1)
    expect(publicState.pendingToolCalls[0]).toHaveProperty('id', 'tc-1')
    expect(publicState.pendingToolCalls[0]).toHaveProperty('name', 'run_bash')
  })

  test('does not expose messages or completedToolResults', () => {
    const state = createTestAgentState()
    const inventory = {
      enabled: false,
      secretValues: [],
      secretPattern: null,
      aliases: [],
      references: [],
    } as never
    const publicState = buildPublicAgentState(state, inventory) as Record<string, unknown>

    expect(publicState).not.toHaveProperty('messages')
    expect(publicState).not.toHaveProperty('completedToolResults')
    expect(publicState).not.toHaveProperty('toolExecutionLog')
  })

  test('handles empty pending tool calls', () => {
    const state = createTestAgentState({ pendingToolCalls: [] })
    const inventory = {
      enabled: false,
      secretValues: [],
      secretPattern: null,
      aliases: [],
      references: [],
    } as never
    const publicState = buildPublicAgentState(state, inventory)

    expect(publicState.pendingToolCalls).toEqual([])
  })
})
