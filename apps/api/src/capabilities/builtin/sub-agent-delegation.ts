import type { CapabilityDefinition } from '../types.js'

export const subAgentDelegation: CapabilityDefinition = {
  slug: 'sub-agent-delegation',
  name: 'Sub-Agent Delegation',
  description: 'Delegate focused tasks to specialized sub-agents that run in isolated context',
  icon: 'Users',
  category: 'core',
  version: '1.0.0',
  tools: [
    {
      name: 'delegate_task',
      description: `Delegate a task to a focused sub-agent. Available roles:
- explore: Fast read-only agent for searching, reading files, web browsing (cheap model)
- analyze: Read-only agent for data analysis with Python and document search (compact model)
- execute: Full-capability agent for complex multi-step tasks (primary model)

The sub-agent runs in an isolated context and returns its findings. Use this when:
1. A task can be cleanly separated (e.g., "search for X" while you work on Y)
2. A task needs focused attention without polluting the main conversation context
3. You want to use a cheaper model for simple information gathering

**Batch multiple delegate_task calls in a single response whenever possible — they run concurrently and finish much faster than sequential calls.**`,
      parameters: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            enum: ['explore', 'analyze', 'execute'],
            description: 'Sub-agent role determining model tier and available tools',
          },
          task: {
            type: 'string',
            description: 'Clear, self-contained task description for the sub-agent',
          },
          context: {
            type: 'string',
            description:
              'Optional relevant context from the current conversation to pass to the sub-agent',
          },
        },
        required: ['role', 'task'],
      },
    },
  ],
  systemPrompt: `## Sub-Agent Delegation

Some tools are only available through sub-agent delegation. You MUST use delegate_task to access them — do NOT call them directly:

- **run_browser_script**: Delegate with role='explore' to browse websites, take screenshots, scrape data, and interact with web pages.

### Role selection guide
| Role | Use when | Model cost | Example tasks |
|------|----------|------------|---------------|
| explore | Information gathering, browsing, searching | Low | "Find pricing on example.com", "Search docs for X" |
| analyze | Data analysis, summarization, computation | Low | "Analyze this CSV data", "Summarize search results" |
| execute | File modifications, multi-step workflows | High | "Refactor these 3 files", "Set up a cron job" |

### When to delegate
- User asks to visit, browse, or scrape a website → delegate_task(role='explore', task='...')
- User asks to interact with a web page (click, fill forms) → delegate_task(role='explore', task='...')
- Complex multi-step file operations → delegate_task(role='execute', task='...')
- Simple information gathering you could do yourself, but want to keep context clean → delegate_task(role='explore', task='...')

### Handling sub-agent results
The sub-agent is a full extension of you.
If it browses a page, reads content, or takes a screenshot and describes what it sees, that description IS the summary — you do NOT need to repeat the work yourself, use the summary to build the required output.
Trust the sub-agent's textual report as if you had done it directly. Only re-delegate if the sub-agent explicitly fails or returns incomplete information.

**CRITICAL: Do NOT copy-paste or repeat the sub-agent's result verbatim.** Synthesize a concise, user-friendly response. If you need to call another tool (like generate_file) after receiving the sub-agent result, include ALL your text and the tool call in a SINGLE response — do not explain first, then call the tool in a separate turn, as this causes the user to see your explanation twice.

### How to delegate effectively
Provide a clear, self-contained task description. Include the full URL and what information to extract. The sub-agent has no access to the current conversation — pass all relevant context in the task and context parameters.

### Large artifacts
When delegating a task that needs a screenshot or visual inspection:
- The sub-agent can take screenshots and analyze them directly in its own context. Do NOT instruct the sub-agent to save screenshots to disk unless the user EXPLICITLY asks to save/download the image.
- For visual tasks (e.g., "tell me what you see on this page"), simply delegate the task and let the sub-agent browse, observe, and report back with a text description.
  for example,
  > User: "Take a screenshot of example.com and tell me what you see"
  > You: delegate_task(role='explore', task='Navigate to example.com, take a screenshot and describe what you see')
- Only instruct the sub-agent to save to /workspace/.outputs/ when the user explicitly requests a file download, export, or permanent save of the screenshot.
- If you need a large non-image output (report, generated document), instruct the sub-agent to save the artifact to a file and report the path.
  for example,
  > User: "Generate a full report about X and Y"
  > You: delegate_task(role='execute')
- Keep the sub-agent response lightweight and focused on the observed result.


### Parallel delegation — ALWAYS batch independent delegations
When a task involves multiple independent sub-tasks, delegate ALL of them in a single response. They execute concurrently and complete much faster than sequential delegation.

**Do this (parallel — fast):**
> User: "Compare pricing for Notion, Slack, and Linear"
> You: 3x delegate_task(role='explore') in ONE response — one per product.

**Not this (sequential — slow):**
> delegate_task for Notion → wait → delegate_task for Slack → wait → delegate_task for Linear`,
  sandbox: {},
}
