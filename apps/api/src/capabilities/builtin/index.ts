import type { CapabilityDefinition } from '../types.js'
import { documentSearch } from './document-search.js'
import { agentMemory } from './agent-memory.js'
import { cronManagement } from './cron-management.js'
import { webSearch } from './web-search.js'
import { googleWorkspace } from './google-workspace.js'
import { browserAutomation } from './browser-automation.js'
import { toolDiscovery } from './tool-discovery.js'
import { webFetch } from './web-fetch.js'

// Only capabilities with custom (non-sandbox) execution logic remain as builtins.
// bash, python, aws-cli, kubectl, docker have been migrated to .skill files.
export const BUILTIN_CAPABILITIES: CapabilityDefinition[] = [
  documentSearch,
  agentMemory,
  cronManagement,
  webSearch,
  webFetch,
  googleWorkspace,
  browserAutomation,
  toolDiscovery,
]

export const BUILTIN_CAPABILITIES_MAP = new Map<string, CapabilityDefinition>(
  BUILTIN_CAPABILITIES.map((c) => [c.slug, c]),
)
