import { describe, it, expect, vi } from 'vitest'
import type { SSECallbacks } from './use-chat-sse'
import { handleSSEEvent, readSSEStream } from './use-chat-sse'

function makeCallbacks(): SSECallbacks {
  return {
    setMessages: vi.fn(),
    setIsPending: vi.fn(),
    setThinkingMessage: vi.fn(),
    setPendingApprovals: vi.fn(),
    setIsCompressing: vi.fn(),
    invalidateContainer: vi.fn(),
  }
}

describe('handleSSEEvent', () => {
  it('session event calls onSessionId', () => {
    const cb = makeCallbacks()
    const onSession = vi.fn()
    handleSSEEvent('session', { sessionId: 's-123' }, 'a1', cb, onSession)
    expect(onSession).toHaveBeenCalledWith('s-123')
  })

  it('thinking event sets thinking message', () => {
    const cb = makeCallbacks()
    handleSSEEvent('thinking', { message: 'Processing...' }, 'a1', cb)
    expect(cb.setThinkingMessage).toHaveBeenCalledWith('Processing...')
  })

  it('content event clears thinking and updates messages', () => {
    const cb = makeCallbacks()
    handleSSEEvent('content', { text: 'Hello' }, 'a1', cb)
    expect(cb.setThinkingMessage).toHaveBeenCalledWith(null)
    expect(cb.setMessages).toHaveBeenCalledWith(expect.any(Function))
  })

  it('tool_start event clears thinking, invalidates container, and updates messages', () => {
    const cb = makeCallbacks()
    handleSSEEvent(
      'tool_start',
      {
        toolCallId: 'tc-1',
        toolName: 'run_bash',
        capabilitySlug: 'shell',
        input: { command: 'ls' },
      },
      'a1',
      cb,
    )
    expect(cb.setThinkingMessage).toHaveBeenCalledWith(null)
    expect(cb.invalidateContainer).toHaveBeenCalled()
    expect(cb.setMessages).toHaveBeenCalledWith(expect.any(Function))
  })

  it('tool_result event updates messages', () => {
    const cb = makeCallbacks()
    handleSSEEvent('tool_result', { toolName: 'run_bash', output: 'files', exitCode: 0 }, 'a1', cb)
    expect(cb.setMessages).toHaveBeenCalledWith(expect.any(Function))
  })

  it('approval_required event adds pending approval and clears thinking', () => {
    const cb = makeCallbacks()
    handleSSEEvent(
      'approval_required',
      {
        approvalId: 'ap-1',
        toolName: 'run_bash',
        capabilitySlug: 'shell',
        input: { command: 'rm -rf /' },
      },
      'a1',
      cb,
    )
    expect(cb.setPendingApprovals).toHaveBeenCalledWith(expect.any(Function))
    expect(cb.setThinkingMessage).toHaveBeenCalledWith(null)
  })

  it('done event returns receivedDone true', () => {
    const cb = makeCallbacks()
    const result = handleSSEEvent('done', { sessionId: 's-1' }, 'a1', cb)
    expect(result.receivedDone).toBe(true)
    expect(cb.setThinkingMessage).toHaveBeenCalledWith(null)
    expect(cb.setIsCompressing).toHaveBeenCalledWith(false)
  })

  it('done event calls onSessionId if sessionId present', () => {
    const cb = makeCallbacks()
    const onSession = vi.fn()
    handleSSEEvent('done', { sessionId: 's-1' }, 'a1', cb, onSession)
    expect(onSession).toHaveBeenCalledWith('s-1')
  })

  it('error event sets error on assistant message', () => {
    const cb = makeCallbacks()
    handleSSEEvent('error', { message: 'Something failed' }, 'a1', cb)
    expect(cb.setThinkingMessage).toHaveBeenCalledWith(null)
    expect(cb.setMessages).toHaveBeenCalledWith(expect.any(Function))
  })

  it('sub_agent_start event creates sub_agent block', () => {
    const cb = makeCallbacks()
    handleSSEEvent(
      'sub_agent_start',
      { subAgentId: 'sa-1', role: 'explore', task: 'find files' },
      'a1',
      cb,
    )
    expect(cb.setThinkingMessage).toHaveBeenCalledWith(null)
    expect(cb.setMessages).toHaveBeenCalledWith(expect.any(Function))
  })

  it('sub_agent_done event updates sub_agent block status', () => {
    const cb = makeCallbacks()
    handleSSEEvent('sub_agent_done', { subAgentId: 'sa-1', summary: 'Found 3 files' }, 'a1', cb)
    expect(cb.setMessages).toHaveBeenCalledWith(expect.any(Function))
  })

  it('aborted event clears pending state', () => {
    const cb = makeCallbacks()
    handleSSEEvent('aborted', {}, 'a1', cb)
    expect(cb.setIsPending).toHaveBeenCalledWith(false)
    expect(cb.setThinkingMessage).toHaveBeenCalledWith(null)
    expect(cb.setPendingApprovals).toHaveBeenCalledWith([])
  })

  it('unknown event type does not crash and returns receivedDone false', () => {
    const cb = makeCallbacks()
    const result = handleSSEEvent('unknown_event_xyz', { foo: 'bar' }, 'a1', cb)
    expect(result.receivedDone).toBe(false)
  })

  it('non-done events return receivedDone false', () => {
    const cb = makeCallbacks()
    expect(handleSSEEvent('content', { text: 'hi' }, 'a1', cb).receivedDone).toBe(false)
    expect(handleSSEEvent('thinking', { message: '...' }, 'a1', cb).receivedDone).toBe(false)
    expect(handleSSEEvent('session', { sessionId: 's' }, 'a1', cb).receivedDone).toBe(false)
  })

  it('compressing start sets compressing state', () => {
    const cb = makeCallbacks()
    handleSSEEvent('compressing', { status: 'start' }, 'a1', cb)
    expect(cb.setIsCompressing).toHaveBeenCalledWith(true)
    expect(cb.setThinkingMessage).toHaveBeenCalledWith('Compressing conversation history...')
  })

  it('compressing done clears compressing and sets summary message', () => {
    const cb = makeCallbacks()
    handleSSEEvent('compressing', { status: 'done', summarizedCount: 5 }, 'a1', cb)
    expect(cb.setIsCompressing).toHaveBeenCalledWith(false)
    expect(cb.setThinkingMessage).toHaveBeenCalledWith('Summarized 5 older messages to save tokens')
  })
})

describe('readSSEStream', () => {
  function makeSSEResponse(text: string): Response {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text))
        controller.close()
      },
    })
    return new Response(stream)
  }

  it('reads stream and dispatches events', async () => {
    const sseText =
      'event: session\ndata: {"sessionId":"s1"}\n\nevent: content\ndata: {"text":"Hello"}\n\nevent: done\ndata: {"sessionId":"s1"}\n\n'
    const res = makeSSEResponse(sseText)
    const cb = makeCallbacks()
    const onSession = vi.fn()

    const result = await readSSEStream(res, 'a1', cb, onSession)
    expect(result.receivedDone).toBe(true)
    expect(onSession).toHaveBeenCalledWith('s1')
    expect(cb.setMessages).toHaveBeenCalled()
  })

  it('handles invalid JSON data gracefully', async () => {
    const sseText = 'event: content\ndata: not-json\n\nevent: done\ndata: {}\n\n'
    const res = makeSSEResponse(sseText)
    const cb = makeCallbacks()

    const result = await readSSEStream(res, 'a1', cb)
    expect(result.receivedDone).toBe(true)
  })

  it('returns receivedDone false when stream has no done event', async () => {
    const sseText = 'event: content\ndata: {"text":"hi"}\n\n'
    const res = makeSSEResponse(sseText)
    const cb = makeCallbacks()

    const result = await readSSEStream(res, 'a1', cb)
    expect(result.receivedDone).toBe(false)
  })

  it('respects abort signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const sseText = 'event: content\ndata: {"text":"hi"}\n\n'
    const res = makeSSEResponse(sseText)
    const cb = makeCallbacks()

    const result = await readSSEStream(res, 'a1', cb, undefined, controller.signal)
    // With pre-aborted signal, it should exit early
    expect(result.receivedDone).toBe(false)
  })
})
