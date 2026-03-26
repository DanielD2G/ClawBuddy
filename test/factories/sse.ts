import { vi } from 'vitest'

// -----------------------------------------------------------------------
// SSE event builder helpers
// -----------------------------------------------------------------------

export function sessionEvent(sessionId = 'mock-session-id') {
  return { event: 'session' as const, data: { sessionId } }
}

export function contentEvent(text: string) {
  return { event: 'content' as const, data: { text } }
}

export function toolStartEvent(
  toolName: string,
  options?: { capabilitySlug?: string; input?: Record<string, unknown>; toolCallId?: string },
) {
  return {
    event: 'tool_start' as const,
    data: {
      toolCallId: options?.toolCallId ?? `tc-${toolName}`,
      toolName,
      capabilitySlug: options?.capabilitySlug ?? 'shell',
      input: options?.input ?? {},
    },
  }
}

export function toolResultEvent(
  toolName: string,
  options?: {
    output?: string
    error?: string
    exitCode?: number
    durationMs?: number
    toolCallId?: string
  },
) {
  return {
    event: 'tool_result' as const,
    data: {
      toolCallId: options?.toolCallId ?? `tc-${toolName}`,
      toolName,
      output: options?.output ?? '',
      error: options?.error,
      exitCode: options?.exitCode ?? 0,
      durationMs: options?.durationMs ?? 100,
    },
  }
}

export function doneEvent(options?: { messageId?: string; sessionId?: string }) {
  return {
    event: 'done' as const,
    data: {
      sessionId: options?.sessionId ?? 'mock-session-id',
      ...(options?.messageId ? { messageId: options.messageId } : {}),
    },
  }
}

export function errorEvent(message: string) {
  return { event: 'error' as const, data: { message } }
}

export function thinkingEvent(message = 'Thinking...') {
  return { event: 'thinking' as const, data: { message } }
}

// -----------------------------------------------------------------------
// SSE stream mock builder
// -----------------------------------------------------------------------

interface SSEStreamEvent {
  event: string
  data: Record<string, unknown>
}

/**
 * Create a mock Response whose body is a ReadableStream of SSE-formatted events.
 * Useful for testing frontend SSE consumers.
 *
 * Usage:
 *   const response = createMockSSEStream([
 *     sessionEvent(),
 *     contentEvent('Hello'),
 *     doneEvent({ messageId: 'msg-1' }),
 *   ])
 *   // response.body is a ReadableStream of "event: ...\ndata: ...\n\n" chunks
 */
export function createMockSSEStream(events: SSEStreamEvent[]): Response {
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      for (const evt of events) {
        const chunk = `event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}

/**
 * Create a mock SSEEmit function that records all emitted events.
 * Useful for testing server-side code that calls emit().
 *
 * Usage:
 *   const { emit, events } = createMockSSEEmit()
 *   await chatService.sendMessage(sessionId, 'hi', emit)
 *   expect(events).toContainEqual({ event: 'done', data: expect.any(Object) })
 */
export function createMockSSEEmit() {
  const events: Array<{ event: string; data: Record<string, unknown> }> = []
  const emit = vi.fn().mockImplementation((event: string, data: Record<string, unknown>) => {
    events.push({ event, data })
  })
  return { emit, events }
}
