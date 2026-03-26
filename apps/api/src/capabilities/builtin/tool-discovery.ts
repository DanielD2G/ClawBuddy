import type { CapabilityDefinition } from '../types.js'

export const toolDiscovery: CapabilityDefinition = {
  slug: 'tool-discovery',
  name: 'Tool Discovery',
  description:
    'Dynamically discovers and loads relevant tools based on the user query. The only natively loaded capability — all other tools are discovered through this.',
  icon: 'Search',
  category: 'builtin',
  version: '1.0.0',
  tools: [
    {
      name: 'discover_tools',
      description:
        'Search for available tools and capabilities that match what you need to do. Returns tool definitions and instructions that become available for subsequent calls.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Natural language description of what you need to do (e.g. "run a python script", "execute AWS CLI commands", "automate browser", "search documents")',
          },
          list_all: {
            type: 'boolean',
            description:
              'If true, returns a compact list of all available tool names and descriptions instead of semantic search',
          },
          max_results: {
            type: 'number',
            description:
              'Maximum number of capabilities to return from semantic search (default: 3)',
          },
        },
        required: ['query'],
      },
    },
  ],
  systemPrompt: `You have ONLY the discover_tools tool available natively. ALL other tools (bash, python, web search, web fetch, document search, browser, cron, sub-agent delegation, file reading, etc.) must be discovered before use.

CRITICAL WORKFLOW:
1. When the user asks you to do something, FIRST call discover_tools with a query describing what you need.
2. discover_tools will return tool definitions that become available for the rest of the conversation.
3. Only then can you use the discovered tools to fulfill the request.
4. If no matching tools are found, try discover_tools with list_all: true to see everything available.

You can control how many results are returned with the max_results parameter (default: 3).
Example: discover_tools({"query": "web search fetch", "max_results": 2})

After discover_tools returns tools, they remain available for the entire conversation — do NOT call discover_tools again for the same capability.`,
  sandbox: {},
}
