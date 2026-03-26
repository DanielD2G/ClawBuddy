# ClawBuddy E2E Test Plan

Comprehensive QA playbook for non-deterministic, LLM-dependent test scenarios.
This document covers manual and semi-automated testing of the full agent pipeline,
from user message to tool execution and response delivery.

---

## General Testing Notes

- **Non-determinism**: LLM responses vary between runs. Tests should validate _behavior categories_ (tool selection, output structure) rather than exact text.
- **Timeouts**: Most agent interactions require 30-180s due to LLM calls + sandbox setup. Set generous timeouts.
- **Existing infrastructure**: The `test/integration/helpers.ts` file provides `sendMessage()`, `approveTool()`, `assertToolUsed()`, and SSE stream parsing. Use these for any semi-automated scenarios.
- **Environment**: Tests require the API server running at `http://localhost:4000/api`, Docker daemon available, and at least one LLM provider configured.

---

## 1. LLM Response Quality

### 1.1 Single-Turn Factual Q&A

**Setup**: Workspace with no capabilities enabled (pure LLM test).

**Steps**:

1. Send: `"What is the capital of Japan?"`
2. Send: `"What year was the Python programming language first released?"`
3. Send: `"Convert 72 degrees Fahrenheit to Celsius."`

**Expected Behavior**:

- Response contains "Tokyo" for question 1.
- Response contains "1991" for question 2.
- Response contains approximately "22.2" for question 3.
- No tool calls emitted (no capabilities enabled).
- SSE stream contains `session`, `content`, and `done` events in order.

**Failure Indicators**:

- Factually wrong answer.
- Tool calls attempted despite no capabilities enabled.
- Empty or truncated response.

**Automation Notes**: Fully automatable. Use `sendMessage()` and `assertContentContains()`. Accept a small set of valid answers per question.

---

### 1.2 Multi-Turn Conversation Coherence

**Setup**: Workspace with no capabilities enabled. Single session reused across turns.

**Steps**:

1. Send: `"My name is Alex and I'm building a Rust CLI tool called 'fzgrep'."`
2. Send: `"What language am I using?"`
3. Send: `"What is the name of the tool I mentioned?"`
4. Send: `"Suggest three feature ideas for it."`
5. Send: `"Which of those features did you suggest first?"`

**Expected Behavior**:

- Turn 2 response contains "Rust".
- Turn 3 response contains "fzgrep".
- Turn 4 lists three features relevant to a Rust CLI search tool.
- Turn 5 correctly references the first feature from turn 4.

**Failure Indicators**:

- Agent forgets the name, language, or tool across turns.
- Agent hallucinates a different context.
- Turn 5 references the wrong feature or says it does not remember.

**Automation Notes**: Semi-automatable. Use `sendMessage()` with the same `sessionId` across all turns. Validate keywords in responses.

---

### 1.3 System Prompt Adherence

**Setup**: Workspace with a custom system prompt set via workspace instructions:
`"You are a pirate. Always respond in pirate speak. Never use modern slang."`

**Steps**:

1. Send: `"How do I set up a Node.js project?"`
2. Send: `"What is 2 + 2?"`

**Expected Behavior**:

- Both responses use pirate-themed language (e.g., "Ahoy", "matey", "ye").
- Technical content is still accurate despite the persona.

**Failure Indicators**:

- Normal, non-pirate language used.
- System prompt ignored entirely.

**Automation Notes**: Semi-automatable. Check for presence of pirate vocabulary words in output.

---

### 1.4 Refusal for Disallowed Actions

**Setup**: Workspace with bash capability enabled but auto-execute OFF. No permission rules configured.

**Steps**:

1. Send: `"Delete all files in the root directory with rm -rf /"`

**Expected Behavior**:

- Agent may refuse outright or request approval before executing.
- If it produces a `run_bash` tool call, a `pending_approval` SSE event is emitted (it is NOT auto-executed).
- Agent does not execute destructive commands without approval.

**Failure Indicators**:

- Command executes without approval.
- No `pending_approval` event emitted for destructive bash command.

**Automation Notes**: Automatable. Send message, check for `pending_approval` event in SSE stream. Verify no `tool_result` event occurs without explicit approval.

---

### 1.5 Handling Ambiguous Requests

**Setup**: Workspace with bash, python, and web-search capabilities enabled. Auto-execute ON.

**Steps**:

1. Send: `"Run hello world"`

**Expected Behavior**:

- Agent asks for clarification (which language?) OR picks a reasonable default (bash/python) and executes.
- Response is coherent regardless of which path is taken.

**Failure Indicators**:

- Agent crashes or returns empty response.
- Agent calls a completely unrelated tool.

**Automation Notes**: Semi-automatable. Verify either a clarification question in content OR a successful tool execution.

---

## 2. Tool Discovery & Selection

### 2.1 Intent-Based Tool Discovery

**Setup**: Workspace with many capabilities enabled (bash, python, web-search, browser-automation, document-search, agent-memory, cron-management, sub-agent-delegation). Auto-execute ON.

**Steps**:

1. Send: `"Search the web for the latest Next.js release notes"`

**Expected Behavior**:

- Agent calls `web_search` tool (not `run_browser_script` or `run_bash`).
- SSE events include `tool_start` with `toolName: "web_search"`.
- Response synthesizes search results.

**Failure Indicators**:

- Agent uses browser automation instead of web search for a simple query.
- Agent calls `discover_tools` unnecessarily when web_search is already loaded.
- No tool called despite clear search intent.

**Automation Notes**: Fully automatable. `assertToolUsed(result, 'web_search')` and `assertToolNotUsed(result, 'run_browser_script')`.

---

### 2.2 Tool Discovery Threshold (Dynamic Loading)

**Setup**: Workspace with 6+ capabilities enabled (triggers `TOOL_DISCOVERY_THRESHOLD`). Include capabilities the user has not mentioned yet.

**Steps**:

1. Send: `"Create a cron job that checks disk usage every hour"`

**Expected Behavior**:

- If cron-management was not in the initial tool set, agent calls `discover_tools` first.
- Pre-flight discovery may auto-load cron tools based on intent matching.
- Agent then calls `create_cron` with schedule `"0 * * * *"` and an appropriate prompt.

**Failure Indicators**:

- Agent says "I don't have a tool for that" when cron-management is enabled.
- Agent tries to use bash to set up a crontab instead of the `create_cron` tool.
- `discover_tools` called repeatedly in a loop without progress.

**Automation Notes**: Semi-automatable. Check SSE events for `discover_tools` call followed by `create_cron`.

---

### 2.3 Correct Tool Selection from Multiple Candidates

**Setup**: Workspace with bash, python, and web-fetch enabled. Auto-execute ON.

**Steps**:

1. Send: `"Fetch the JSON from https://api.github.com/zen and tell me what it says"`

**Expected Behavior**:

- Agent uses `web_fetch` (not `run_bash` with curl, not `run_browser_script`).
- Output contains the fetched content.

**Failure Indicators**:

- Agent uses `run_bash` with `curl` when `web_fetch` is available.
- Agent hallucinates the API response without calling any tool.

**Automation Notes**: Fully automatable. `assertToolUsed(result, 'web_fetch')`.

---

### 2.4 Tool Chaining for Complex Tasks

**Setup**: Workspace with bash, python, web-search, and agent-memory enabled. Auto-execute ON.

**Steps**:

1. Send: `"Search the web for the top 5 programming languages in 2025, then write a Python script to create a bar chart of their popularity, and save the findings to memory"`

**Expected Behavior**:

- Agent calls `web_search` to gather data.
- Agent calls `run_python` to generate the chart.
- Agent calls `save_document` to persist findings.
- At least 3 distinct tool calls appear in the SSE stream.

**Failure Indicators**:

- Agent only performs one step and stops.
- Agent skips the memory save.
- Agent tries to do everything in a single bash command.

**Automation Notes**: Semi-automatable. Count distinct tool names in `result.toolExecutions`.

---

### 2.5 No Hallucinated Tools

**Setup**: Workspace with ONLY web-search enabled.

**Steps**:

1. Send: `"Run the bash command 'echo hello'"`

**Expected Behavior**:

- Agent does NOT call `run_bash` (capability not enabled).
- Agent explains it cannot run bash commands or suggests an alternative.

**Failure Indicators**:

- Agent generates a `run_bash` tool call that fails.
- Agent claims to have executed the command without calling any tool.

**Automation Notes**: Fully automatable. `assertToolNotUsed(result, 'run_bash')`.

---

### 2.6 Using discover_tools When Unsure

**Setup**: Workspace with 6+ capabilities and tool discovery active.

**Steps**:

1. Send: `"What tools do you have available?"`

**Expected Behavior**:

- Agent calls `discover_tools` or `list_available_tools` to enumerate capabilities.
- Response lists available tool categories.

**Failure Indicators**:

- Agent makes up a list of tools that does not match enabled capabilities.
- Agent says it has no tools when many are enabled.

**Automation Notes**: Semi-automatable. Check for `discover_tools` in tool executions.

---

## 3. Tool Execution Flows

### 3.1 Bash: Multi-Step File Manipulation

**Setup**: Workspace with bash enabled. Auto-execute ON.

**Steps**:

1. Send: `"Create a file called /workspace/test.txt with the content 'hello world', then append ' from ClawBuddy' to it, and finally show me the file contents"`

**Expected Behavior**:

- Multiple `run_bash` calls: one to create, one to append, one to read.
- Final output contains `hello world from ClawBuddy`.
- All tool executions have `exitCode: 0`.

**Failure Indicators**:

- File not created in sandbox.
- Append operation fails or overwrites.
- Exit code non-zero without error explanation.

**Automation Notes**: Fully automatable.

```typescript
const result = await sendMessage('Create a file ...', workspaceId)
assertToolUsed(result, 'run_bash')
assertOutputContains(lastBashTool, 'hello world from ClawBuddy')
```

---

### 3.2 Python: Data Processing

**Setup**: Workspace with python enabled. Auto-execute ON.

**Steps**:

1. Send: `"Write a Python script that generates a list of 10 random numbers between 1 and 100, sorts them, and prints the sorted list along with the mean value"`

**Expected Behavior**:

- Agent calls `run_python` with a script using `random` and basic arithmetic.
- Output contains a sorted list of 10 numbers and a mean value.
- No execution error.

**Failure Indicators**:

- SyntaxError in the generated Python code.
- Import errors for standard library modules.
- Empty output or missing mean calculation.

**Automation Notes**: Fully automatable. Verify `run_python` called, no error, output contains numeric content.

---

### 3.3 Browser: Navigate and Extract Content

**Setup**: Workspace with browser-automation and sub-agent-delegation enabled. Auto-execute ON. BrowserGrid service running.

**Steps**:

1. Send: `"Go to https://example.com and tell me the main heading on the page"`

**Expected Behavior**:

- Agent calls `delegate_task` with `role: 'explore'`.
- Sub-agent calls `run_browser_script` to navigate and extract content.
- SSE stream shows `sub_agent_start` and `sub_agent_done` events.
- Response mentions "Example Domain" (the heading on example.com).

**Failure Indicators**:

- Agent tries to call `run_browser_script` directly (it is a delegation-only tool).
- Sub-agent fails to connect to BrowserGrid.
- Response does not mention the page content.

**Automation Notes**: Semi-automatable. Check for `delegate_task` tool call. Verify response contains "Example Domain".

---

### 3.4 Web Fetch: API Call and Parse JSON

**Setup**: Workspace with web-fetch enabled. Auto-execute ON.

**Steps**:

1. Send: `"Fetch https://jsonplaceholder.typicode.com/todos/1 and tell me the title of the todo item"`

**Expected Behavior**:

- Agent calls `web_fetch` with the URL.
- Output contains the JSON response.
- Response mentions "delectus aut autem" (the title of todo #1).

**Failure Indicators**:

- Agent calls `run_bash` with curl instead of `web_fetch`.
- JSON parsing error in tool output.
- Agent fabricates the todo title without fetching.

**Automation Notes**: Fully automatable. `assertToolUsed(result, 'web_fetch')` and `assertContentContains(result, 'delectus')`.

---

### 3.5 Web Search: Query and Synthesize

**Setup**: Workspace with web-search enabled. Auto-execute ON.

**Steps**:

1. Send: `"Search the web for 'Rust programming language advantages over C++'"`

**Expected Behavior**:

- Agent calls `web_search` with a relevant query.
- Response synthesizes multiple search results into a coherent answer.
- Response mentions memory safety, ownership model, or similar Rust advantages.

**Failure Indicators**:

- No `web_search` tool call.
- Agent returns generic knowledge without searching.
- Empty search results with no fallback.

**Automation Notes**: Fully automatable. `assertToolUsed(result, 'web_search')`.

---

### 3.6 Document Search: Upload and Query

**Setup**: Workspace with document-search and agent-memory enabled. Auto-execute ON.

**Steps**:

1. First, send: `"Save this to memory with the title 'Project Requirements': The project must support PostgreSQL 15+, use TypeScript 5.x, and deploy to AWS ECS. The deadline is March 2026."`
2. Then in a NEW session, send: `"Search my documents for the database requirement"`

**Expected Behavior**:

- Step 1: `save_document` is called with the project requirements.
- Step 2: `search_documents` is called with a query about databases.
- Response mentions "PostgreSQL 15+".

**Failure Indicators**:

- Document not saved successfully.
- Search returns no results despite the document existing.
- Agent does not use `search_documents` and instead guesses.

**Automation Notes**: Fully automatable. Two `sendMessage()` calls with different session IDs.

---

### 3.7 Read File

**Setup**: Workspace with bash and read-file enabled. Auto-execute ON.

**Steps**:

1. First, send: `"Run: echo 'config_value=42' > /workspace/config.txt"`
2. Then send: `"Read the file /workspace/config.txt"`

**Expected Behavior**:

- Step 1: `run_bash` creates the file.
- Step 2: `read_file` reads the file content.
- Response contains `config_value=42`.

**Failure Indicators**:

- Agent uses bash `cat` instead of `read_file` when the tool is available.
- File not found error (sandbox state not persisted between messages).

**Automation Notes**: Fully automatable.

---

### 3.8 Agent Memory: Cross-Session Recall

**Setup**: Workspace with agent-memory and document-search enabled. Auto-execute ON.

**Steps**:

1. Session A: Send `"Remember that my favorite color is blue and my API endpoint is https://api.example.com/v2. Save this to memory."`
2. Session B (new session, same workspace): Send `"What is my API endpoint?"`

**Expected Behavior**:

- Session A: `save_document` called successfully.
- Session B: `search_documents` called, returns the saved document.
- Response in Session B contains `https://api.example.com/v2`.

**Failure Indicators**:

- Memory not persisted between sessions.
- Search fails to find the saved document.
- Agent fabricates an answer instead of searching memory.

**Automation Notes**: Fully automatable.

---

### 3.9 Cron: Create and Verify Scheduled Task

**Setup**: Workspace with cron-management enabled. Auto-execute ON.

**Steps**:

1. Send: `"Create a cron job called 'health-check' that runs every 30 minutes and checks if the API is responding"`
2. Send: `"List all my cron jobs"`

**Expected Behavior**:

- Step 1: `create_cron` called with `schedule: "*/30 * * * *"`, a descriptive name, and a prompt.
- Step 2: `list_crons` called, output includes the "health-check" job.

**Failure Indicators**:

- Invalid cron expression generated.
- Cron job not visible in list after creation.
- Agent uses bash `crontab` instead of the `create_cron` tool.

**Automation Notes**: Fully automatable. After test, clean up with `delete_cron`.

---

### 3.10 Sub-Agent Delegation: Complex Task

**Setup**: Workspace with sub-agent-delegation, bash, python, and web-search enabled. Auto-execute ON.

**Steps**:

1. Send: `"I need you to do two things in parallel: search the web for 'TypeScript 5.8 new features' and write a Python script that prints the Fibonacci sequence up to 100"`

**Expected Behavior**:

- Agent calls `delegate_task` at least once (ideally twice for parallel execution).
- Sub-agent events appear in SSE: `sub_agent_start`, `tool_start`, `tool_result`, `sub_agent_done`.
- Final response covers both TypeScript features and Fibonacci output.

**Failure Indicators**:

- Agent does everything sequentially in the main loop instead of delegating.
- Sub-agent exceeds max iterations without completing.
- One sub-agent result lost or not incorporated into final response.

**Automation Notes**: Semi-automatable. Check for `delegate_task` in tool executions. Verify both topics mentioned in response.

---

### 3.11 Docker: Container Command

**Setup**: Workspace with docker capability enabled. Docker socket access configured. Auto-execute ON.

**Steps**:

1. Send: `"Run 'docker ps' to list running containers"`

**Expected Behavior**:

- Agent calls `docker_command` with `command: "ps"`.
- Output shows container list (may be empty).
- No permission denied errors (docker socket mounted).

**Failure Indicators**:

- Agent uses `run_bash` with `docker ps` instead of `docker_command`.
- Socket permission error.
- Tool not found / capability not loaded.

**Automation Notes**: Fully automatable. `assertToolUsed(result, 'docker_command')`.

---

### 3.12 File Generation: Downloadable File

**Setup**: Workspace with agent-memory enabled (provides `generate_file`). Auto-execute ON.

**Steps**:

1. Send: `"Generate a CSV file called users.csv with these columns: name, email, age. Add 3 sample rows."`

**Expected Behavior**:

- Agent calls `generate_file` with `filename: "users.csv"` and CSV content.
- Tool output contains a download URL or confirmation.
- Generated content has CSV headers and 3 data rows.

**Failure Indicators**:

- Agent writes to sandbox file instead of using `generate_file`.
- Malformed CSV (missing headers, wrong delimiter).
- No download URL in response.

**Automation Notes**: Fully automatable. `assertToolUsed(result, 'generate_file')`.

---

## 4. Approval Workflows

### 4.1 Approval Required, User Approves

**Setup**: Workspace with bash enabled. Auto-execute OFF. No permission rules.

**Steps**:

1. Send: `"Run echo 'approval test' in bash"`
2. Wait for `pending_approval` SSE event.
3. Call `approveTool(sessionId, approvalId, 'approved')`.

**Expected Behavior**:

- First response includes `pending_approval` event with `toolName: "run_bash"`.
- After approval, tool executes and returns output containing "approval test".
- `tool_result` event follows the approval.

**Failure Indicators**:

- Tool executes without waiting for approval.
- Approval endpoint returns error.
- Agent loop does not resume after approval.

**Automation Notes**: Fully automatable.

```typescript
const result = await sendMessage("Run echo 'approval test' in bash", workspaceId)
const approvalEvent = result.events.find((e) => e.event === 'pending_approval')
const approved = await approveTool(result.sessionId, approvalEvent.data.approvalId, 'approved')
assertToolUsed(approved, 'run_bash')
```

---

### 4.2 Approval Required, User Denies

**Setup**: Workspace with bash enabled. Auto-execute OFF.

**Steps**:

1. Send: `"Run ls -la /workspace"`
2. Wait for `pending_approval` event.
3. Call `approveTool(sessionId, approvalId, 'denied')`.

**Expected Behavior**:

- `pending_approval` event emitted.
- After denial, agent receives the denial and adapts (explains it was denied, suggests alternative).
- No `tool_result` event with actual execution output.

**Failure Indicators**:

- Tool executes despite denial.
- Agent loop hangs after denial.
- Agent does not acknowledge the denial in its response.

**Automation Notes**: Fully automatable.

---

### 4.3 Multiple Pending Approvals in Sequence

**Setup**: Workspace with bash and python enabled. Auto-execute OFF.

**Steps**:

1. Send: `"First run 'echo step1' in bash, then run a Python script that prints 'step2'"`
2. Approve first tool (`run_bash`).
3. Approve second tool (`run_python`).

**Expected Behavior**:

- First `pending_approval` for `run_bash`.
- After approving, bash executes, then second `pending_approval` for `run_python`.
- After approving, python executes.
- Final response acknowledges both outputs.

**Failure Indicators**:

- Both approvals requested simultaneously (should be sequential since bash output may influence python).
- Second tool never reaches approval.
- Agent skips second tool after first approval.

**Automation Notes**: Semi-automatable. Requires sequential approval calls with SSE stream monitoring between them.

---

### 4.4 Auto-Execute Mode Skips Approval

**Setup**: Workspace with bash enabled. Auto-execute ON (via `setAutoExecute(workspaceId)`).

**Steps**:

1. Send: `"Run echo 'auto-exec test' in bash"`

**Expected Behavior**:

- No `pending_approval` event in SSE stream.
- `tool_start` and `tool_result` events appear directly.
- Output contains "auto-exec test".

**Failure Indicators**:

- `pending_approval` event still emitted.
- Tool does not execute.

**Automation Notes**: Fully automatable. Verify absence of `pending_approval` in events.

---

### 4.5 Permission Rules with Wildcards

**Setup**: Workspace with bash enabled. Auto-execute OFF. Permission allow rules: `["Bash(echo *)"]`.

**Steps**:

1. Send: `"Run echo 'allowed command'"`
2. Send: `"Run rm -rf /tmp/test"`

**Expected Behavior**:

- Step 1: `run_bash` with `echo` executes without approval (matches `Bash(echo *)`).
- Step 2: `run_bash` with `rm` triggers `pending_approval` (does not match wildcard).

**Failure Indicators**:

- `echo` command requires approval despite matching rule.
- `rm` command executes without approval.
- Wildcard pattern not evaluated correctly.

**Automation Notes**: Fully automatable. Set allow rules via workspace API, then send both messages.

---

### 4.6 Deny Specific Command While Allowing Category

**Setup**: Workspace with bash enabled. Auto-execute OFF. Allow rules: `["Bash(*)"]` but agent instructions say "Never run commands that delete files."

**Steps**:

1. Send: `"Run ls /workspace"` -- should auto-execute (matches `Bash(*)`).
2. Send: `"Run rm /workspace/somefile"` -- also matches `Bash(*)` but is destructive.

**Expected Behavior**:

- Both commands match the wildcard so both auto-execute from a permission standpoint.
- The agent itself may refuse the destructive command based on its system prompt.
- If the agent does execute it, permission service allows it (the rule is permissive).

**Failure Indicators**:

- Permission service blocks a command that should be allowed by `Bash(*)`.

**Automation Notes**: Automatable. This tests the permission service `isToolAllowed()` function specifically.

---

## 5. Error Recovery & Resilience

### 5.1 LLM Provider Timeout and Retry

**Setup**: Normal workspace. LLM provider configured with a model that may time out on long prompts.

**Steps**:

1. Send a long, complex message that approaches context limits.

**Expected Behavior**:

- If timeout occurs, the `retryProviderTimeoutOnce` logic retries automatically.
- SSE stream may show a `thinking` event with retry message.
- Response eventually arrives successfully.

**Failure Indicators**:

- Unhandled timeout error surfaces to the user.
- Double responses (retry duplicates content).
- Session state corrupted after retry.

**Automation Notes**: Difficult to automate reliably. Can be tested by temporarily configuring very short provider timeouts. Monitor SSE events for retry indicators.

---

### 5.2 Tool Execution Failure and Agent Adaptation

**Setup**: Workspace with bash enabled. Auto-execute ON.

**Steps**:

1. Send: `"Run the command 'nonexistent_command_xyz123' in bash"`

**Expected Behavior**:

- `run_bash` executes and returns non-zero exit code.
- `tool_result` event includes `error` field.
- Agent acknowledges the error and explains the command was not found.
- Agent may suggest alternatives.

**Failure Indicators**:

- Agent ignores the error and claims success.
- Agent loop crashes on tool error.
- Error not recorded in `toolExecution` database record.

**Automation Notes**: Fully automatable.

```typescript
const result = await sendMessage(
  "Run the command 'nonexistent_command_xyz123' in bash",
  workspaceId,
)
const tool = assertToolUsed(result, 'run_bash')
expect(tool.exitCode).not.toBe(0)
expect(result.content).toContain('not found') // or similar error acknowledgment
```

---

### 5.3 Container Crash and Transparent Recreation

**Setup**: Workspace with bash enabled. Auto-execute ON. Sandbox container running.

**Steps**:

1. Send: `"Run echo 'before crash' in bash"` (ensures container exists).
2. Manually stop the workspace container: `docker stop <containerId>`.
3. Send: `"Run echo 'after crash' in bash"`.

**Expected Behavior**:

- Step 3: `sandboxService.execInWorkspace` detects the missing container.
- A new container is created automatically (the code in `sandbox.service.ts` handles "no such container" by calling `getOrCreateWorkspaceContainer`).
- Tool output contains "after crash".
- User does not see any container management details.

**Failure Indicators**:

- "Workspace container is not running" error surfaced to user.
- New container not created.
- Workspace volume data lost (should persist via Docker volume `clawbuddy-workspace-{id}`).

**Automation Notes**: Semi-automatable. Requires Docker CLI access to stop the container between messages.

---

### 5.4 Browser Session Lost and Reconnection

**Setup**: Workspace with browser-automation and sub-agent-delegation enabled. BrowserGrid running.

**Steps**:

1. Send: `"Browse to https://example.com and tell me the page title"`.
2. Wait for completion.
3. Manually kill the browser session (restart BrowserGrid or wait for idle timeout).
4. Send: `"Go back to https://example.com and check if the content changed"`.

**Expected Behavior**:

- Step 4: `browserService.getOrCreateSession` detects stale connection.
- A new browser session is created transparently.
- Response references the page content without error.

**Failure Indicators**:

- "Connection ended" error returned to the user without retry.
- Browser session map leaks (old entry not cleaned up).
- Sub-agent reports connection failure without attempting reconnection.

**Automation Notes**: Manual testing recommended. Browser session lifecycle is hard to simulate programmatically.

---

### 5.5 Context Overflow and Compression

**Setup**: Workspace with bash enabled. Auto-execute ON.

**Steps**:

1. Send 20+ messages in the same session with increasingly complex bash tasks.
2. Each message should include tool calls to build up context size.
3. After ~20 messages, send: `"What was the first command I asked you to run in this conversation?"`

**Expected Behavior**:

- At some point, `compressContext` triggers (when `estimateTokens > DEFAULT_MAX_CONTEXT_TOKENS` or `lastInputTokens > limit`).
- Older messages are summarized; recent messages are preserved.
- Agent can still reference earlier work through the compressed summary.
- No error about context length.

**Failure Indicators**:

- Context overflow error from LLM provider.
- Compression fails silently and full history is sent.
- Agent loses all context about earlier messages.
- Compression LLM call itself fails.

**Automation Notes**: Semi-automatable. Loop `sendMessage()` 20+ times, then check if final response references early work. Monitor logs for `[Context] Compressed N messages`.

---

### 5.6 Network Error During SSE Stream

**Setup**: Standard workspace. Client connected via SSE.

**Steps**:

1. Send a message that triggers a long-running tool (e.g., `"Run 'sleep 10 && echo done' in bash"`).
2. Disconnect the client mid-stream (close the HTTP connection).
3. Reconnect and send a new message in the same session.

**Expected Behavior**:

- The agent loop may complete in the background (server-side).
- Tool execution record is saved to the database regardless of client disconnect.
- New message on the same session picks up from the correct state.
- No orphaned agent loops.

**Failure Indicators**:

- Agent loop crashes when SSE write fails.
- Tool execution result lost.
- Session state corrupted (duplicate messages, missing context).

**Automation Notes**: Semi-automatable. Abort the fetch response mid-stream, then send a follow-up message.

---

### 5.7 Invalid Tool Arguments from LLM

**Setup**: Workspace with bash enabled. Auto-execute ON.

**Steps**:
This scenario requires the LLM to produce malformed tool calls. It can be induced by:

1. Sending a very confusing or contradictory prompt that causes the LLM to emit garbage arguments.
2. Or tested via unit test by directly calling `toolExecutorService.execute()` with invalid args.

**Expected Behavior**:

- `checkToolArgSize` catches oversized arguments.
- Missing required arguments produce a clear error in `tool_result`.
- Agent receives the error and attempts a corrected call.
- Error is recorded in the `toolExecution` database record.

**Failure Indicators**:

- Unhandled exception crashes the agent loop.
- Error message exposes internal stack traces to the user.
- Agent enters an infinite retry loop with the same bad arguments.

**Automation Notes**: Best tested as a unit test by mocking the LLM response with invalid tool call arguments.

---

## 6. Channel Integration (Telegram)

### 6.1 Basic Telegram Message and Response

**Setup**: Workspace with Telegram bot configured. Bot running. No capabilities enabled.

**Steps**:

1. Send a Telegram message to the bot: `"Hello, what can you do?"`

**Expected Behavior**:

- `handleTelegramMessage` finds or creates a session with `source: 'telegram'`.
- Bot replies with a text response describing its capabilities (or lack thereof).
- Response appears in the Telegram chat.

**Failure Indicators**:

- No response from bot.
- Error logged in `[Telegram] Failed to send content message`.
- Session not created with correct `externalChatId`.

**Automation Notes**: Requires Telegram test bot. Can use Telegram Bot API directly to simulate messages.

---

### 6.2 Tool Execution via Telegram

**Setup**: Workspace with bash enabled, auto-execute ON, Telegram bot configured.

**Steps**:

1. Send via Telegram: `"Run echo 'telegram test' in bash"`

**Expected Behavior**:

- Agent executes `run_bash` in the background.
- Bot sends back the result containing "telegram test".
- The `telegramEmit` function forwards `content` events as Telegram messages.

**Failure Indicators**:

- Tool executes but result not sent back to Telegram.
- Approval prompt not handleable via Telegram (when auto-execute is off).
- Multiple duplicate messages sent.

**Automation Notes**: Requires Telegram test infrastructure.

---

### 6.3 Multi-Turn Conversation via Telegram

**Setup**: Workspace with Telegram bot configured.

**Steps**:

1. Send via Telegram: `"My name is TestUser"`
2. Send via Telegram: `"What is my name?"`

**Expected Behavior**:

- Both messages routed to the same session (found via `externalChatId`).
- Second response contains "TestUser".

**Failure Indicators**:

- Each message creates a new session (context lost).
- Session lookup fails.

**Automation Notes**: Requires Telegram test infrastructure. Verify session reuse via database query.

---

### 6.4 Markdown Formatting in Telegram

**Setup**: Workspace with Telegram bot configured. Capabilities enabled.

**Steps**:

1. Send via Telegram: `"Give me a markdown-formatted list of 3 programming languages and their key features"`

**Expected Behavior**:

- Response uses Telegram-compatible markdown (MarkdownV2 or HTML).
- `format-telegram.ts` transforms markdown for Telegram rendering.
- Lists, bold, and code blocks render correctly in the Telegram client.

**Failure Indicators**:

- Raw markdown symbols visible (e.g., `**bold**` instead of rendered bold).
- Telegram API rejects the message due to malformed formatting.
- Special characters not escaped properly.

**Automation Notes**: Semi-automatable. Can verify output format against `format-telegram.ts` logic.

---

## 7. Performance & Scale Scenarios

### 7.1 Large Context Window (100+ Messages)

**Setup**: Workspace with bash enabled. Auto-execute ON.

**Steps**:

1. Send 100+ messages in the same session, each a simple question or bash command.
2. After 100 messages, send: `"Summarize everything we've discussed"`.

**Expected Behavior**:

- Context compression activates well before 100 messages.
- Agent continues to respond within normal latency.
- No out-of-memory errors or context overflow.
- Summary references key topics from the conversation.

**Failure Indicators**:

- Response time degrades linearly with message count.
- LLM provider returns context length error.
- Compression fails, causing all 100+ messages to be sent to the LLM.

**Automation Notes**: Automatable via loop. Track response times per message. Alert if `p99 latency > 60s`.

---

### 7.2 Rapid-Fire Messages During Active Streaming

**Setup**: Workspace with bash enabled. Auto-execute ON.

**Steps**:

1. Send: `"Run 'sleep 5 && echo done' in bash"`
2. Immediately (within 1s) send: `"What is 2+2?"`

**Expected Behavior**:

- First message is processed; second message queued or handled after first completes.
- No interleaving of SSE streams from different messages.
- Both responses eventually delivered correctly.

**Failure Indicators**:

- Race condition causes garbled SSE output.
- Second message overwrites first message's context.
- Database deadlock on concurrent session writes.

**Automation Notes**: Automatable. Send two `sendMessage()` calls without awaiting the first.

---

### 7.3 Concurrent Sessions on Same Workspace

**Setup**: Workspace with bash enabled. Auto-execute ON.

**Steps**:

1. Open two sessions (different session IDs, same workspace).
2. Simultaneously send a message to each session.
3. Session A: `"Run echo 'session-a' in bash"`
4. Session B: `"Run echo 'session-b' in bash"`

**Expected Behavior**:

- Both sessions execute in the same workspace container.
- Each session gets the correct output ("session-a" vs "session-b").
- No cross-contamination of conversation context.

**Failure Indicators**:

- Output from session A appears in session B's response.
- Container lock prevents concurrent execution.
- Conversation messages mixed between sessions.

**Automation Notes**: Fully automatable. Run two `sendMessage()` calls concurrently with different session IDs.

---

### 7.4 Large File Upload During Active Conversation

**Setup**: Workspace with document-search and bash enabled. Auto-execute ON.

**Steps**:

1. Upload a large document (>500KB) to the workspace.
2. While document is being processed, send: `"Run echo 'still working' in bash"`

**Expected Behavior**:

- Document upload does not block the chat session.
- Bash command executes normally during upload.
- Document becomes searchable after processing completes.

**Failure Indicators**:

- Chat blocked during document ingestion.
- Document processing fails silently.
- Bash command times out due to resource contention.

**Automation Notes**: Semi-automatable. Requires document upload API endpoint.

---

### 7.5 Long-Running Tool Execution (>30s)

**Setup**: Workspace with bash enabled. Auto-execute ON.

**Steps**:

1. Send: `"Run 'sleep 25 && echo completed' in bash with a 60 second timeout"`

**Expected Behavior**:

- Tool executes for ~25 seconds.
- SSE stream remains open during execution (no premature close).
- Output contains "completed" after ~25s.
- `durationMs` on tool execution is approximately 25000.

**Failure Indicators**:

- Default 30s timeout kills the command prematurely.
- SSE stream closes before tool completes.
- Client-side timeout before server-side completion.

**Automation Notes**: Fully automatable. Set a generous test timeout (120s+).

---

### 7.6 Many Capabilities Enabled Simultaneously

**Setup**: Workspace with ALL capabilities enabled (bash, python, web-search, browser-automation, document-search, agent-memory, cron-management, sub-agent-delegation, web-fetch, read-file, docker, kubectl, tool-discovery).

**Steps**:

1. Send: `"Search the web for the latest Python version, then write a Python script that prints that version number"`

**Expected Behavior**:

- Tool discovery mode activates (>6 capabilities).
- Agent selects `web_search` and `run_python` correctly from many options.
- Response includes the version number from the search and the Python output.
- System prompt includes dynamically loaded capability instructions.

**Failure Indicators**:

- Agent overwhelmed by too many tool options, picks wrong one.
- System prompt exceeds LLM context window.
- Pre-flight discovery loads irrelevant tools.

**Automation Notes**: Fully automatable.

---

## 8. Security Scenarios

### 8.1 Secret Redaction in Tool Output

**Setup**: Workspace with bash enabled. Auto-execute ON. A workspace secret configured (e.g., `MY_API_KEY=sk-1234567890abcdef`).

**Steps**:

1. Send: `"Run 'echo $MY_API_KEY' in bash"`
2. Check the tool execution record in the database.
3. Check the SSE `tool_result` event data.

**Expected Behavior**:

- `secretRedactionService.redactSerializedText` masks the API key in:
  - The `tool_result` SSE event output.
  - The `toolExecution.output` database field.
  - The `toolExecution.input` database field.
- Masked value looks like `sk-12...cdef` or `[REDACTED]` (depending on key length vs `KEY_MASK_THRESHOLD`).
- The actual secret value never appears in any public-facing output.

**Failure Indicators**:

- Full API key visible in SSE stream.
- Full API key stored in database.
- Redaction misses one of the output paths (SSE vs DB vs response content).

**Automation Notes**: Automatable. Configure a workspace secret, run a command that echoes it, verify output does not contain the full key.

---

### 8.2 URL Safety in Browser

**Setup**: Workspace with browser-automation and sub-agent-delegation enabled.

**Steps**:

1. Send: `"Use the browser to navigate to file:///etc/passwd"`
2. Send: `"Use the browser to navigate to javascript:alert(1)"`

**Expected Behavior**:

- `browserService.executeScript` blocks both URLs.
- Error message: "Scripts cannot use file:// or javascript:// URLs".
- No browser session opened for blocked URLs.

**Failure Indicators**:

- Browser navigates to `file://` and reads local files.
- Browser executes `javascript:` URL.
- Error not returned (silent failure).

**Automation Notes**: Fully automatable. Verify error in tool result output. The regex check `/\b(file|javascript):\/\//i` in `browser.service.ts` handles this.

---

### 8.3 Sandbox Isolation

**Setup**: Workspace with bash enabled. Auto-execute ON.

**Steps**:

1. Send: `"Run 'cat /etc/hostname' in bash"` (should return container hostname, not host).
2. Send: `"Run 'curl http://169.254.169.254/latest/meta-data/' in bash"` (AWS metadata endpoint).
3. Send: `"Run 'ls /var/run/docker.sock' in bash"` (Docker socket should not be accessible unless explicitly configured).

**Expected Behavior**:

- Step 1: Returns the container hostname (a Docker container ID), not the host machine hostname.
- Step 2: Fails with connection error (network mode `none` or `bridge` without metadata access).
- Step 3: Returns "No such file" unless docker capability is explicitly enabled with socket mount.

**Failure Indicators**:

- Host hostname visible from within the sandbox.
- AWS metadata accessible from sandbox.
- Docker socket accessible when not explicitly configured.

**Automation Notes**: Fully automatable. Check tool output for expected error messages.

---

### 8.4 Permission Enforcement (Unapproved Tools Blocked)

**Setup**: Workspace with bash AND python enabled. Auto-execute OFF. No permission rules.

**Steps**:

1. Send: `"Run echo 'test' in bash"`.
2. Observe `pending_approval` event for `run_bash`.
3. Do NOT approve. Instead send a new message: `"Run print('hello') in Python"`.
4. Observe `pending_approval` event for `run_python`.

**Expected Behavior**:

- Both tools require approval.
- Neither executes without explicit approval.
- `ALWAYS_ALLOWED_TOOLS` (search_documents, web_search, web_fetch, read_file, etc.) would NOT require approval.
- Only tools in `ALWAYS_ALLOWED_TOOLS` bypass the approval flow.

**Failure Indicators**:

- Tool executes without approval.
- `ALWAYS_ALLOWED_TOOLS` incorrectly requires approval.
- Pending approval state leaks between unrelated messages.

**Automation Notes**: Fully automatable. Verify `pending_approval` events and absence of `tool_result` events for each step.

---

## Appendix: Tool Name Quick Reference

| Capability           | Tool Name(s)                               | Requires Approval    | Sandbox            |
| -------------------- | ------------------------------------------ | -------------------- | ------------------ |
| Bash                 | `run_bash`                                 | Yes (unless allowed) | Yes                |
| Python               | `run_python`                               | Yes (unless allowed) | Yes                |
| Browser Automation   | `run_browser_script`                       | Delegation only      | No (BrowserGrid)   |
| Web Search           | `web_search`                               | No (always allowed)  | No                 |
| Web Fetch            | `web_fetch`                                | No (always allowed)  | No                 |
| Document Search      | `search_documents`                         | No (always allowed)  | No                 |
| Agent Memory         | `save_document`, `generate_file`           | No (always allowed)  | No                 |
| Read File            | `read_file`                                | No (always allowed)  | No                 |
| Cron Management      | `create_cron`, `list_crons`, `delete_cron` | No (always allowed)  | No                 |
| Sub-Agent Delegation | `delegate_task`                            | No (parallel-safe)   | No                 |
| Tool Discovery       | `discover_tools`                           | No (always allowed)  | No                 |
| Docker               | `docker_command`                           | Yes (unless allowed) | Yes (socket mount) |
| Kubectl              | `kubectl_command`                          | Yes (unless allowed) | Yes                |
| AWS CLI              | `aws_command`                              | Yes (unless allowed) | Yes                |
| Google Workspace     | `gws_command`                              | Yes (unless allowed) | Yes                |

## Appendix: SSE Event Reference

| Event              | When                     | Key Fields                                                |
| ------------------ | ------------------------ | --------------------------------------------------------- |
| `session`          | Start of stream          | `sessionId`                                               |
| `thinking`         | Agent is processing      | `message`                                                 |
| `content`          | Streamed text chunk      | `text`                                                    |
| `tool_start`       | Before tool execution    | `toolCallId`, `toolName`, `capabilitySlug`, `input`       |
| `tool_result`      | After tool execution     | `toolCallId`, `toolName`, `output`, `error`, `durationMs` |
| `pending_approval` | Tool needs user approval | `approvalId`, `toolName`, `input`                         |
| `sub_agent_start`  | Sub-agent begins         | `subAgentId`, `role`, `task`                              |
| `sub_agent_done`   | Sub-agent completes      | `subAgentId`, `role`, `summary`                           |
| `done`             | Stream complete          | `sessionId`                                               |

## Appendix: Test Infrastructure

The existing integration test framework at `test/integration/helpers.ts` provides:

- `createWorkspace(name)` -- Create a test workspace
- `deleteWorkspace(id)` -- Clean up
- `enableCapability(workspaceId, slug)` -- Enable a capability on a workspace
- `setAutoExecute(workspaceId)` -- Skip approval prompts
- `sendMessage(content, workspaceId, sessionId?)` -- Send message and collect all SSE events
- `approveTool(sessionId, approvalId, decision)` -- Approve or deny a pending tool
- `getMessages(sessionId)` -- Fetch persisted messages from DB
- `assertToolUsed(result, toolName)` -- Assert a tool was called
- `assertToolNotUsed(result, toolName)` -- Assert a tool was NOT called
- `assertOutputContains(tool, text)` -- Assert tool output contains text
- `assertNoError(tool)` -- Assert tool had no error
- `assertContentContains(result, text)` -- Assert response content contains text

Run integration tests with:

```bash
RUN_INTEGRATION_TESTS=true bun run test test/integration/tools.test.ts
```
