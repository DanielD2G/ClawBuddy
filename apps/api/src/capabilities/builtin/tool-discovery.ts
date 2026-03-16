import type { CapabilityDefinition } from '../types.js'

export const toolDiscovery: CapabilityDefinition = {
  slug: 'tool-discovery',
  name: 'Tool Discovery',
  description:
    'Dynamically discovers and loads relevant tools based on the user query. Activated automatically when many capabilities are enabled.',
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
              'Natural language description of what you need to do (e.g. "run a python script", "execute AWS CLI commands", "automate browser")',
          },
          list_all: {
            type: 'boolean',
            description:
              'If true, returns a compact list of all available tool names and descriptions instead of semantic search',
          },
        },
        required: ['query'],
      },
    },
  ],
  systemPrompt: `You have a discover_tools tool to find and load capabilities not yet available.

The tools currently loaded (document search, memory, bash, python) can be used directly without discovery. For ANY OTHER tool (web search, browser, AWS, Docker, etc.), call discover_tools first with a short description of what you need.

After discover_tools returns, the relevant tools are available for the rest of this conversation — do NOT call discover_tools again for the same capability. If no relevant tools are found, try calling discover_tools with list_all: true to see all available capabilities.`,
  sandbox: {},
}
