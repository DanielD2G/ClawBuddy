// ── Sub-Agent Delegation Types ──────────────────────────────

export type SubAgentRole = 'explore' | 'analyze' | 'execute'

export type SubAgentModelTier = 'explore' | 'execute' | 'light' | 'primary'

export interface SubAgentRoleConfig {
  role: SubAgentRole
  description: string
  modelTier: SubAgentModelTier
  readOnly: boolean
  /** Tool name allowlist, or 'all' for full access */
  allowedTools: string[] | 'all'
  /** Explicit deny list (applied when allowedTools is 'all') */
  deniedTools?: string[]
}

export interface SubAgentRequest {
  role: SubAgentRole
  task: string
  context?: string
}

export interface SubAgentResult {
  role: SubAgentRole
  success: boolean
  result: string
  toolExecutions: Array<{
    toolName: string
    capabilitySlug: string
    input: Record<string, unknown>
    output?: string
    error?: string
    durationMs: number
  }>
  iterationsUsed: number
  tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number }
}
