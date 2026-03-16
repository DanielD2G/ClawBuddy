import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import {
  createWorkspace,
  deleteWorkspace,
  enableCapability,
  setAutoExecute,
  sendMessage,
  getMessages,
  assertToolUsed,
  assertToolNotUsed,
  assertOutputContains,
  assertNoError,
} from './helpers'

const TIMEOUT = 180_000 // 3 min per test — LLM calls + sandbox setup can be slow

let workspaceId: string

const ALL_CAPABILITIES = [
  'document-search',
  'bash',
  'python',
  'agent-memory',
  'cron-management',
  'web-search',
  'browser-automation',
  'aws-cli',
  'gh-cli',
]

beforeAll(async () => {
  console.log('🔧 Setting up test workspace...')
  const ws = await createWorkspace(`Integration Tests ${Date.now()}`)
  workspaceId = ws.id
  console.log(`   Workspace: ${ws.id}`)

  // Enable all capabilities
  for (const slug of ALL_CAPABILITIES) {
    await enableCapability(workspaceId, slug)
  }
  console.log(`   Enabled ${ALL_CAPABILITIES.length} capabilities`)

  // Skip approval prompts
  await setAutoExecute(workspaceId)
  console.log('   Auto-execute enabled')
}, TIMEOUT)

afterAll(async () => {
  if (workspaceId) {
    await deleteWorkspace(workspaceId)
    console.log('🧹 Cleaned up test workspace')
  }
}, 30_000)

// ─── Bash ───

describe('Bash', () => {
  test(
    'executes echo command',
    async () => {
      const result = await sendMessage('Run the command `echo hello world` in bash', workspaceId)
      const tool = assertToolUsed(result, 'run_bash')
      assertNoError(tool)
      assertOutputContains(tool, 'hello world')
    },
    TIMEOUT,
  )
})

// ─── Python ───

describe('Python', () => {
  test(
    'executes multi-line script (fibonacci)',
    async () => {
      const result = await sendMessage(
        'Write a Python script that calculates the first 10 fibonacci numbers and prints them as a list',
        workspaceId,
      )
      const tool = assertToolUsed(result, 'run_python')
      assertNoError(tool)
      // Fibonacci: 0, 1, 1, 2, 3, 5, 8, 13, 21, 34
      expect(tool.output).toContain('8')
      expect(tool.output).toContain('13')
    },
    TIMEOUT,
  )

  test(
    'handles imports and JSON (base64 encoding validation)',
    async () => {
      const result = await sendMessage(
        'Write a Python script that imports json, creates a dict {"name": "test", "count": 42, "active": true}, and prints it with json.dumps(indent=2)',
        workspaceId,
      )
      const tool = assertToolUsed(result, 'run_python')
      assertNoError(tool)
      // Should NOT have SyntaxError (validates base64 fix)
      expect(tool.error).toBeFalsy()
      expect(tool.output).toContain('test')
      expect(tool.output).toContain('42')
    },
    TIMEOUT,
  )
})

// ─── Web Search ───

describe('Web Search', () => {
  test(
    'uses web_search tool',
    async () => {
      const result = await sendMessage(
        'Search the web for "who is the current president of France"',
        workspaceId,
      )
      const tool = assertToolUsed(result, 'web_search')
      // Should return some content about France
      expect(result.content.length).toBeGreaterThan(0)
    },
    TIMEOUT,
  )

  test(
    'prefers web_search over browser for simple queries',
    async () => {
      const result = await sendMessage(
        'Find information about the latest stable Node.js version number',
        workspaceId,
      )
      assertToolUsed(result, 'web_search')
      assertToolNotUsed(result, 'run_browser_script')
    },
    TIMEOUT,
  )
})

// ─── Browser Automation ───

describe('Browser Automation', () => {
  test(
    'navigates to example.com and reads content',
    async () => {
      const result = await sendMessage(
        '/browser-automation Navigate to https://example.com and use getReadableContent() to extract the page text',
        workspaceId,
      )
      assertToolUsed(result, 'run_browser_script')
      // Check all tool outputs and content for "example" (case-insensitive)
      const allText = [
        result.content,
        ...result.toolExecutions.map((t) => t.output ?? ''),
      ].join(' ').toLowerCase()
      expect(allText).toContain('example')
    },
    TIMEOUT,
  )

  test(
    'uses step-by-step approach (multiple calls)',
    async () => {
      const result = await sendMessage(
        'Use browser automation to navigate to https://example.com, discover all interactive elements, then take a screenshot',
        workspaceId,
      )
      const browserCalls = result.toolExecutions.filter((t) => t.toolName === 'run_browser_script')
      // Should make multiple calls (step-by-step), not cram everything into one
      expect(browserCalls.length).toBeGreaterThanOrEqual(2)
    },
    240_000, // Browser multi-step can be slow
  )
})

// ─── Agent Memory ───

describe('Agent Memory', () => {
  test(
    'saves a document to memory',
    async () => {
      const result = await sendMessage(
        'Remember this: The integration test suite was last run on March 14, 2026. Save this to memory.',
        workspaceId,
      )
      const tool = assertToolUsed(result, 'save_document')
      assertNoError(tool)
    },
    TIMEOUT,
  )
})

// ─── File Generation ───

describe('File Generation', () => {
  test(
    'generates a CSV file',
    async () => {
      const result = await sendMessage(
        'Generate a CSV file called users.csv with 5 rows of sample data: name, email, age',
        workspaceId,
      )
      const tool = assertToolUsed(result, 'generate_file')
      assertNoError(tool)
      // Output should contain download URL or filename
      expect(tool.output).toBeTruthy()
    },
    TIMEOUT,
  )
})

// ─── AWS CLI ───

describe('AWS CLI', () => {
  test(
    'calls aws command (may fail without credentials)',
    async () => {
      const result = await sendMessage(
        'Run `aws sts get-caller-identity` to check AWS credentials',
        workspaceId,
      )
      const tool = assertToolUsed(result, 'aws_command')
      // Tool was called — success or credential error is fine
      expect(tool.output || tool.error).toBeTruthy()
    },
    TIMEOUT,
  )
})

// ─── GitHub CLI ───

describe('GitHub CLI', () => {
  test(
    'calls gh command (may fail without token)',
    async () => {
      const result = await sendMessage(
        'Run `gh auth status` to check GitHub authentication status',
        workspaceId,
      )
      const tool = assertToolUsed(result, 'gh_command')
      // Tool was called — success or auth error is fine
      expect(tool.output || tool.error).toBeTruthy()
    },
    TIMEOUT,
  )
})

// ─── Mentioned Capability Forced ───

describe('Capability Mentions', () => {
  test(
    '/browser-automation forces browser tool usage',
    async () => {
      const result = await sendMessage(
        '/browser-automation go to https://example.com and read the page',
        workspaceId,
      )
      assertToolUsed(result, 'run_browser_script')
    },
    TIMEOUT,
  )
})

// ─── Message Persistence ───

describe('Persistence', () => {
  test(
    'saves intermediate content and tool executions to DB',
    async () => {
      const result = await sendMessage(
        'Run `echo persistence-test-123` in bash and then tell me the result',
        workspaceId,
      )
      assertToolUsed(result, 'run_bash')

      // Wait a moment for DB write
      await new Promise((r) => setTimeout(r, 2000))

      // Fetch from DB
      const data = await getMessages(result.sessionId)
      const assistantMsg = data.messages?.find((m) => m.role === 'assistant')

      expect(assistantMsg).toBeTruthy()
      expect(assistantMsg!.content.length).toBeGreaterThan(0)

      // Tool executions should be linked
      if (assistantMsg!.toolExecutions?.length) {
        const bashExec = assistantMsg!.toolExecutions.find((t) => t.toolName === 'run_bash')
        expect(bashExec).toBeTruthy()
      }
    },
    TIMEOUT,
  )
})

// ─── SSE Event Ordering ───

describe('SSE Ordering', () => {
  test(
    'content events appear between tool events (not all at end)',
    async () => {
      const result = await sendMessage(
        'First run `echo step-1` in bash, then run `echo step-2` in bash. Explain what each command does between calls.',
        workspaceId,
      )

      // Should have at least 2 tool calls
      const bashCalls = result.toolExecutions.filter((t) => t.toolName === 'run_bash')
      expect(bashCalls.length).toBeGreaterThanOrEqual(2)

      // Check SSE event ordering: there should be content events between tool events
      const eventTypes = result.events
        .filter((e) => ['content', 'tool_start', 'tool_result'].includes(e.event))
        .map((e) => e.event)

      // Should not be all tool events followed by all content events
      // Look for pattern: ...tool_result...content...tool_start... (interleaved)
      const firstContent = eventTypes.indexOf('content')
      const lastToolResult = eventTypes.lastIndexOf('tool_result')

      // Content should appear before the last tool result (interleaved, not all at end)
      if (bashCalls.length >= 2) {
        expect(firstContent).toBeLessThan(lastToolResult)
      }
    },
    240_000, // Multiple sequential LLM calls
  )
})
