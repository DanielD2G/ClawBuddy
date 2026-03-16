export type SSEEvent =
  | { event: 'thinking'; data: { message: string } }
  | { event: 'tool_start'; data: { toolName: string; capabilitySlug: string; input: Record<string, unknown> } }
  | { event: 'tool_result'; data: { toolName: string; output?: string; error?: string; exitCode?: number; durationMs: number } }
  | { event: 'approval_required'; data: { approvalId: string; toolName: string; capabilitySlug: string; input: Record<string, unknown> } }
  | { event: 'content'; data: { text: string } }
  | { event: 'title_update'; data: { title: string } }
  | { event: 'sources'; data: { sources: unknown[] } }
  | { event: 'done'; data: { messageId?: string; sessionId: string } }
  | { event: 'error'; data: { message: string } }
  | { event: 'awaiting_approval'; data: { approvalIds: string[] } }
  | { event: 'session'; data: { sessionId: string } }
  | { event: 'context_compressed'; data: Record<string, unknown> }
  | { event: 'compressing'; data: { status: 'start' | 'done' | 'skipped'; summarizedCount?: number; keptCount?: number } }

export type SSEEmit = (event: SSEEvent['event'], data: Record<string, unknown>) => void

export function createSSEStream(handler: (emit: SSEEmit) => Promise<void>): Response {
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const emit: SSEEmit = (event, data) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          // Stream may be closed
        }
      }

      try {
        await handler(emit)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error'
        emit('error', { message })
      } finally {
        try {
          controller.close()
        } catch {
          // Already closed
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
