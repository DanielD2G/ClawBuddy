/**
 * Integration test helpers for AgentBuddy API.
 * Sends real HTTP requests to the running API server.
 */

const API_BASE = process.env.API_BASE ?? 'http://localhost:4000/api'

export interface SSEEvent {
  event: string
  data: Record<string, unknown>
}

export interface TestResult {
  events: SSEEvent[]
  sessionId: string
  content: string
  toolExecutions: Array<{
    toolName: string
    capabilitySlug?: string
    output?: string
    error?: string
    exitCode?: number
    durationMs?: number
    screenshot?: string
  }>
}

// ─── API Helpers ───

export async function createWorkspace(name: string): Promise<{ id: string; name: string }> {
  const res = await fetch(`${API_BASE}/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const json = (await res.json()) as { data: { id: string; name: string } }
  return json.data
}

export async function deleteWorkspace(id: string): Promise<void> {
  await fetch(`${API_BASE}/workspaces/${id}`, { method: 'DELETE' })
}

export async function enableCapability(workspaceId: string, slug: string): Promise<void> {
  return enableCapabilityWithConfig(workspaceId, slug)
}

export async function enableCapabilityWithConfig(
  workspaceId: string,
  slug: string,
  config?: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${API_BASE}/workspaces/${workspaceId}/capabilities/${slug}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, ...(config ? { config } : {}) }),
  })
  if (!res.ok) {
    const body = await res.text()
    console.warn(`[WARN] Failed to enable ${slug}: ${body}`)
  }
}

export async function setAutoExecute(workspaceId: string): Promise<void> {
  await fetch(`${API_BASE}/workspaces/${workspaceId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ autoExecute: true }),
  })
}

export async function updateWorkspaceSettings(
  workspaceId: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await fetch(`${API_BASE}/workspaces/${workspaceId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  })
}

export async function getMessages(sessionId: string): Promise<{
  messages: Array<{
    id: string
    role: string
    content: string
    toolExecutions?: Array<{ toolName: string; output?: string; error?: string }>
  }>
}> {
  const res = await fetch(`${API_BASE}/chat/sessions/${sessionId}/messages`)
  const json = (await res.json()) as { data: ReturnType<typeof getMessages> extends Promise<infer T> ? T : never }
  return json.data as Awaited<ReturnType<typeof getMessages>>
}

// ─── SSE Stream Parser ───

export async function parseSSEStream(response: Response): Promise<SSEEvent[]> {
  const events: SSEEvent[] = []
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = ''

    let currentEvent = ''
    let currentData = ''

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7)
      } else if (line.startsWith('data: ')) {
        currentData = line.slice(6)
      } else if (line === '' && currentEvent && currentData) {
        try {
          events.push({ event: currentEvent, data: JSON.parse(currentData) })
        } catch {
          // skip malformed
        }
        currentEvent = ''
        currentData = ''
      } else if (line !== '') {
        // Incomplete line — put back in buffer
        buffer = line
      }
    }

    // Preserve partial event data
    if (currentEvent || currentData) {
      if (currentEvent) buffer = `event: ${currentEvent}\n` + buffer
      if (currentData) buffer = `data: ${currentData}\n` + buffer
    }
  }

  return events
}

// ─── Send Message & Collect Results ───

export async function sendMessage(
  content: string,
  workspaceId: string,
  sessionId?: string,
): Promise<TestResult> {
  const res = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, workspaceId, sessionId }),
  })

  if (!res.ok) {
    throw new Error(`Chat request failed: ${res.status} ${await res.text()}`)
  }

  const events = await parseSSEStream(res)

  // Extract session ID
  const sessionEvent = events.find((e) => e.event === 'session')
  const doneEvent = events.find((e) => e.event === 'done')
  const sid = (sessionEvent?.data?.sessionId ?? doneEvent?.data?.sessionId ?? sessionId ?? '') as string

  // Collect content
  const contentParts = events
    .filter((e) => e.event === 'content')
    .map((e) => e.data.text as string)
  const fullContent = contentParts.join('')

  // Collect tool executions
  const toolExecutions: TestResult['toolExecutions'] = []
  for (const e of events) {
    if (e.event === 'tool_start') {
      toolExecutions.push({
        toolName: e.data.toolName as string,
        capabilitySlug: e.data.capabilitySlug as string,
      })
    } else if (e.event === 'tool_result') {
      const existing = toolExecutions.find(
        (t) => t.toolName === (e.data.toolName as string) && !t.output && !t.error,
      )
      if (existing) {
        existing.output = (e.data.output as string) ?? undefined
        existing.error = (e.data.error as string) ?? undefined
        existing.exitCode = (e.data.exitCode as number) ?? undefined
        existing.durationMs = (e.data.durationMs as number) ?? undefined
        existing.screenshot = (e.data.screenshot as string) ?? undefined
      }
    }
  }

  return { events, sessionId: sid, content: fullContent, toolExecutions }
}

export async function approveTool(
  sessionId: string,
  approvalId: string,
  decision: 'approved' | 'denied' = 'approved',
): Promise<TestResult | { status: 'waiting'; pendingCount: number }> {
  const res = await fetch(`${API_BASE}/chat/sessions/${sessionId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approvalId, decision }),
  })

  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const json = await res.json() as { data?: { status?: 'waiting'; pendingCount?: number } }
    return {
      status: json.data?.status ?? 'waiting',
      pendingCount: json.data?.pendingCount ?? 0,
    }
  }

  const events = await parseSSEStream(res)
  const doneEvent = events.find((e) => e.event === 'done')
  const sid = (doneEvent?.data?.sessionId ?? sessionId) as string
  const content = events
    .filter((e) => e.event === 'content')
    .map((e) => e.data.text as string)
    .join('')
  const toolExecutions: TestResult['toolExecutions'] = []
  for (const e of events) {
    if (e.event === 'tool_start') {
      toolExecutions.push({
        toolName: e.data.toolName as string,
        capabilitySlug: e.data.capabilitySlug as string,
      })
    } else if (e.event === 'tool_result') {
      const existing = toolExecutions.find(
        (t) => t.toolName === (e.data.toolName as string) && !t.output && !t.error,
      )
      if (existing) {
        existing.output = (e.data.output as string) ?? undefined
        existing.error = (e.data.error as string) ?? undefined
        existing.exitCode = (e.data.exitCode as number) ?? undefined
        existing.durationMs = (e.data.durationMs as number) ?? undefined
        existing.screenshot = (e.data.screenshot as string) ?? undefined
      }
    }
  }

  return { events, sessionId: sid, content, toolExecutions }
}

// ─── Assertion Helpers ───

export function assertToolUsed(result: TestResult, toolName: string): TestResult['toolExecutions'][0] {
  const tool = result.toolExecutions.find((t) => t.toolName === toolName)
  if (!tool) {
    const used = result.toolExecutions.map((t) => t.toolName).join(', ') || '(none)'
    throw new Error(`Expected tool "${toolName}" to be used. Tools used: ${used}`)
  }
  return tool
}

export function assertToolNotUsed(result: TestResult, toolName: string): void {
  const tool = result.toolExecutions.find((t) => t.toolName === toolName)
  if (tool) {
    throw new Error(`Expected tool "${toolName}" NOT to be used, but it was`)
  }
}

export function assertOutputContains(tool: TestResult['toolExecutions'][0], text: string): void {
  if (!tool.output?.toLowerCase().includes(text.toLowerCase())) {
    throw new Error(
      `Expected output to contain "${text}". Got: ${tool.output?.slice(0, 200) ?? '(no output)'}`,
    )
  }
}

export function assertNoError(tool: TestResult['toolExecutions'][0]): void {
  if (tool.error) {
    throw new Error(`Expected no error but got: ${tool.error}`)
  }
}

export function assertContentContains(result: TestResult, text: string): void {
  if (!result.content.toLowerCase().includes(text.toLowerCase())) {
    throw new Error(
      `Expected content to contain "${text}". Got: ${result.content.slice(0, 300)}`,
    )
  }
}
