import { describe, it, expect } from 'vitest'
import type { ContentBlock, ToolExecutionData, ChatMessage } from './use-chat-types'
import {
  uid,
  mapPendingApprovals,
  findSubAgentBlockIndex,
  matchesToolExecution,
  parseSSEEvents,
  normalizeChatMessages,
} from './use-chat-helpers'

describe('uid', () => {
  it('returns a non-empty string', () => {
    const id = uid()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => uid()))
    expect(ids.size).toBe(100)
  })
})

describe('mapPendingApprovals', () => {
  it('maps API approvals to internal format', () => {
    const input = [
      {
        id: 'a1',
        toolName: 'run_bash',
        capabilitySlug: 'shell',
        input: { command: 'ls' },
      },
    ]
    const result = mapPendingApprovals(input)
    expect(result).toEqual([
      {
        approvalId: 'a1',
        toolName: 'run_bash',
        capabilitySlug: 'shell',
        input: { command: 'ls' },
      },
    ])
  })

  it('returns empty array for undefined', () => {
    expect(mapPendingApprovals(undefined)).toEqual([])
  })

  it('returns empty array for empty array', () => {
    expect(mapPendingApprovals([])).toEqual([])
  })
})

describe('findSubAgentBlockIndex', () => {
  const blocks: ContentBlock[] = [
    { type: 'text', text: 'hello' },
    {
      type: 'sub_agent',
      subAgent: {
        id: 'sa-1',
        role: 'explore',
        task: 'find files',
        tools: [],
        status: 'completed',
      },
    },
    {
      type: 'sub_agent',
      subAgent: {
        id: 'sa-2',
        role: 'execute',
        task: 'run command',
        tools: [],
        status: 'running',
      },
    },
  ]

  it('finds block by subAgentId', () => {
    expect(findSubAgentBlockIndex(blocks, 'sa-1')).toBe(1)
  })

  it('falls back to last running sub_agent when id not found', () => {
    expect(findSubAgentBlockIndex(blocks, 'nonexistent')).toBe(2)
  })

  it('falls back to last running sub_agent when no id provided', () => {
    expect(findSubAgentBlockIndex(blocks)).toBe(2)
  })

  it('returns -1 when no sub_agent blocks exist', () => {
    expect(findSubAgentBlockIndex([{ type: 'text', text: 'hi' }])).toBe(-1)
  })

  it('returns -1 for empty blocks', () => {
    expect(findSubAgentBlockIndex([])).toBe(-1)
  })
})

describe('matchesToolExecution', () => {
  const tool: ToolExecutionData = {
    toolCallId: 'tc-1',
    toolName: 'run_bash',
    input: { command: 'ls' },
    status: 'running',
  }

  it('matches by toolCallId when provided', () => {
    expect(matchesToolExecution(tool, 'run_bash', 'tc-1')).toBe(true)
  })

  it('does not match wrong toolCallId', () => {
    expect(matchesToolExecution(tool, 'run_bash', 'tc-999')).toBe(false)
  })

  it('matches by toolName and running status when no callId', () => {
    expect(matchesToolExecution(tool, 'run_bash')).toBe(true)
  })

  it('does not match wrong toolName', () => {
    expect(matchesToolExecution(tool, 'read_file')).toBe(false)
  })

  it('does not match non-running tool by name alone', () => {
    const completed: ToolExecutionData = { ...tool, status: 'completed' }
    expect(matchesToolExecution(completed, 'run_bash')).toBe(false)
  })
})

describe('parseSSEEvents', () => {
  it('parses a single complete event', () => {
    const buffer = 'event: content\ndata: {"text":"hi"}\n\n'
    const { events, remaining } = parseSSEEvents(buffer)
    expect(events).toEqual([{ event: 'content', data: '{"text":"hi"}' }])
    expect(remaining).toBe('')
  })

  it('parses multiple events', () => {
    const buffer =
      'event: session\ndata: {"sessionId":"s1"}\n\nevent: content\ndata: {"text":"hello"}\n\n'
    const { events, remaining } = parseSSEEvents(buffer)
    expect(events).toHaveLength(2)
    expect(events[0].event).toBe('session')
    expect(events[1].event).toBe('content')
    expect(remaining).toBe('')
  })

  it('preserves incomplete event in remaining', () => {
    const buffer = 'event: content\ndata: {"text":"hi"}\n\nevent: done\n'
    const { events, remaining } = parseSSEEvents(buffer)
    expect(events).toHaveLength(1)
    expect(remaining).toContain('event: done')
  })

  it('handles empty buffer', () => {
    const { events, remaining } = parseSSEEvents('')
    expect(events).toEqual([])
    expect(remaining).toBe('')
  })

  it('handles buffer with only empty lines', () => {
    const { events, remaining } = parseSSEEvents('\n\n\n')
    expect(events).toEqual([])
    expect(remaining).toBe('')
  })

  it('preserves partial data line in remaining', () => {
    const buffer = 'event: content\ndata: {"text":"partial'
    const { events, remaining } = parseSSEEvents(buffer)
    expect(events).toEqual([])
    expect(remaining).toContain('event: content')
    expect(remaining).toContain('data: {"text":"partial')
  })
})

describe('normalizeChatMessages', () => {
  it('passes through normal messages unchanged', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'hi', createdAt: '2024-01-01' },
    ]
    const result = normalizeChatMessages(messages)
    expect(result[0].isError).toBeFalsy()
  })

  it('preserves existing isError flag', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'assistant', content: 'some error', isError: true, createdAt: '2024-01-01' },
    ]
    const result = normalizeChatMessages(messages)
    expect(result[0].isError).toBe(true)
  })

  it('marks assistant messages starting with "Error:" as errors', () => {
    const messages: ChatMessage[] = [
      {
        id: '1',
        role: 'assistant',
        content: 'Error: something went wrong',
        createdAt: '2024-01-01',
      },
    ]
    const result = normalizeChatMessages(messages)
    expect(result[0].isError).toBe(true)
  })

  it('does not mark user messages starting with "Error:" as errors', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'Error: is this a bug?', createdAt: '2024-01-01' },
    ]
    const result = normalizeChatMessages(messages)
    expect(result[0].isError).toBeFalsy()
  })

  it('handles empty array', () => {
    expect(normalizeChatMessages([])).toEqual([])
  })
})
