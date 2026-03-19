import type { ToolCall } from '../providers/llm.interface.js'
import { ALWAYS_ALLOWED_TOOLS } from '../constants.js'

interface ParsedRule {
  type: string
  pattern: string
}

/**
 * Parse a permission rule string like "Bash(aws s3 ls *)" into type and pattern.
 */
function parseRule(rule: string): ParsedRule {
  const match = rule.match(/^(\w+)\((.+)\)$/)
  if (match) {
    return { type: match[1], pattern: match[2] }
  }
  // If no parens, treat entire string as a type with wildcard
  return { type: rule, pattern: '*' }
}

/**
 * Normalize a tool call into a permission-checkable format.
 */
function normalizeToolCall(toolCall: ToolCall): { type: string; value: string } {
  const args = toolCall.arguments as Record<string, unknown>

  switch (toolCall.name) {
    case 'run_bash':
      return { type: 'Bash', value: String(args.command ?? '') }
    case 'aws_command':
      return { type: 'Bash', value: `aws ${String(args.command ?? '')}` }
    case 'kubectl_command':
      return { type: 'Bash', value: `kubectl ${String(args.command ?? '')}` }
    case 'docker_command':
      return { type: 'Bash', value: `docker ${String(args.command ?? '')}` }
    case 'run_python':
      return { type: 'Python', value: String(args.code ?? '') }
    case 'read_file':
    case 'list_files':
      return { type: 'Read', value: String(args.path ?? '/workspace') }
    case 'write_file':
      return { type: 'Write', value: `path:${String(args.path ?? '')}` }
    case 'search_documents':
      return { type: 'SearchDocuments', value: '' }
    case 'save_document':
      return { type: 'SaveDocument', value: String(args.title ?? '') }
    case 'generate_file':
      return { type: 'GenerateFile', value: String(args.filename ?? '') }
    default:
      return { type: toolCall.name, value: '' }
  }
}

/**
 * Simple glob match — supports * as wildcard anywhere in the pattern.
 */
function globMatch(pattern: string, value: string): boolean {
  // Convert glob pattern to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  const regex = new RegExp(`^${escaped}$`)
  return regex.test(value)
}

export const permissionService = {
  /**
   * Check if a tool call is allowed by the given allowlist rules.
   * search_documents is always allowed.
   * If allowRules is empty, nothing is pre-allowed.
   */
  isToolAllowed(toolCall: ToolCall, allowRules: string[]): boolean {
    // Non-destructive tools are always allowed (no approval needed)
    if (ALWAYS_ALLOWED_TOOLS.has(toolCall.name)) return true

    const normalized = normalizeToolCall(toolCall)

    for (const rule of allowRules) {
      const parsed = parseRule(rule)

      if (parsed.type !== normalized.type) continue

      if (globMatch(parsed.pattern, normalized.value)) {
        return true
      }
    }

    return false
  },
}
