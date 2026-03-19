import type { SubAgentRole, SubAgentRoleConfig } from './sub-agent.types.js'

export const SUB_AGENT_ROLES: Record<SubAgentRole, SubAgentRoleConfig> = {
  explore: {
    role: 'explore',
    description:
      'Fast, read-only agent for information gathering: searching documents, reading files, web searches, and browsing. Uses a cheaper/faster model. Cannot modify files or run destructive commands.',
    modelTier: 'explore',
    readOnly: true,
    allowedTools: [
      'search_documents',
      'web_search',
      'run_bash',
      'run_browser_script',
      'discover_tools',
    ],
  },
  analyze: {
    role: 'analyze',
    description:
      'Read-only agent for data analysis and summarization. Can run Python code in a sandboxed environment and search documents. Uses a compact model.',
    modelTier: 'light',
    readOnly: true,
    allowedTools: ['search_documents', 'run_bash', 'run_python'],
  },
  execute: {
    role: 'execute',
    description:
      'Full-capability agent for complex multi-step tasks. Has access to all workspace tools including bash, file writing, and code execution. Uses the primary model. Use for tasks that require modifications or multi-step workflows.',
    modelTier: 'execute',
    readOnly: false,
    allowedTools: 'all',
    deniedTools: ['delegate_task'],
  },
}
