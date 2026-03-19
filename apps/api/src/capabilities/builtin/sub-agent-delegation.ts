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
- explore: Fast read-only agent for searching, reading files, web browsing (cheap model, default 50 iterations, configurable)
- analyze: Read-only agent for data analysis with Python and document search (compact model, default 25 iterations, configurable)
- execute: Full-capability agent for complex multi-step tasks (primary model, default 50 iterations, configurable)

The sub-agent runs in an isolated context and returns its findings. Use this when:
1. A task can be cleanly separated (e.g., "search for X" while you work on Y)
2. A task needs focused attention without polluting the main conversation context
3. You want to use a cheaper model for simple information gathering

You can delegate multiple tasks in parallel by including several delegate_task calls in a single response. They will run concurrently.`,
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

### When to delegate
- User asks to visit, browse, or scrape a website → delegate_task(role='explore', task='...')
- User asks to interact with a web page (click, fill forms) → delegate_task(role='explore', task='...')
- Complex multi-step file operations → delegate_task(role='execute', task='...')

### How to delegate effectively
Provide a clear, self-contained task description. Include the full URL and what information to extract. The sub-agent has no access to the current conversation — pass all relevant context in the task and context parameters.

### Parallel delegation
When a task involves multiple independent sub-tasks (e.g., searching 3 different products, browsing 3 different URLs), delegate ALL of them in a single response with multiple delegate_task calls. They execute concurrently — each sub-agent gets its own isolated browser session — and complete much faster than sequential delegation.`,
  sandbox: {},
}
