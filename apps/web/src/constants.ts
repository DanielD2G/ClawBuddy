// ── Polling intervals (ms) ───────────────────────
export const POLL_SESSIONS_FAST_MS = 3000 // when sessions have no title
export const POLL_SESSIONS_NORMAL_MS = 10000
export const POLL_MESSAGES_MS = 10000
export const POLL_ACTIVE_SESSION_MS = 1500
export const POLL_BROWSER_HEALTH_MS = 10000
export const POLL_BROWSER_SESSIONS_MS = 5000
export const POLL_CONTAINER_STATUS_MS = 10000
export const POLL_CRON_JOBS_MS = 15_000
export const POLL_DOCUMENT_STATUS_MS = 2000
export const POLL_DOCKER_IMAGES_MS = 1500

// ── Update polling intervals (ms) ────────────────
export const POLL_UPDATE_CHECK_MS = 30 * 60 * 1000 // 30 min
export const UPDATE_HEALTH_POLL_MS = 2_000 // 2s
export const UPDATE_INITIAL_DELAY_MS = 10_000 // 10s
export const UPDATE_TIMEOUT_MS = 120_000 // 2 min

// ── Cache staleness (ms) ─────────────────────────
export const DEFAULT_STALE_TIME_MS = 60_000
export const MODEL_CONFIG_STALE_TIME_MS = 60_000

// ── UI truncation ────────────────────────────────
export const SESSION_ID_DISPLAY_LEN = 12
export const SIDEBAR_TITLE_MAX_LEN = 30
export const CODE_PREVIEW_MAX_LEN = 60
export const CODE_APPROVAL_PREVIEW_LEN = 80

// ── Pagination ───────────────────────────────────
export const DEFAULT_PAGE_SIZE = 20

// ── Default settings ─────────────────────────────
export const DEFAULT_CONTEXT_LIMIT_TOKENS = 30000
export const DEFAULT_MAX_AGENT_ITERATIONS = 50
export const DEFAULT_SUB_AGENT_EXPLORE_MAX_ITERATIONS = 50
export const DEFAULT_SUB_AGENT_ANALYZE_MAX_ITERATIONS = 25
export const DEFAULT_SUB_AGENT_EXECUTE_MAX_ITERATIONS = 50

// ── Feature flags ────────────────────────────────
export { ALWAYS_ON_CAPABILITY_SLUGS } from '@clawbuddy/shared'

// ── Workspace colors ─────────────────────────────
export const WORKSPACE_COLORS = [
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#f43f5e',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#06b6d4',
  '#3b82f6',
]

// ── Capability category labels ───────────────────
export const CATEGORY_LABELS: Record<string, string> = {
  builtin: 'Built-in',
  general: 'General',
  languages: 'Languages',
  cloud: 'Cloud',
  devops: 'DevOps',
  integrations: 'Integrations',
}

// ── Permission example rules ────────────────────
export const EXAMPLE_PERMISSION_RULES = [
  'Bash(aws s3 ls *)',
  'Bash(aws ecs describe-*)',
  'Bash(kubectl get *)',
  'Bash(docker ps *)',
  'Read(*)',
  'Write(*)',
  'Python(*)',
  'SearchDocuments(*)',
]

// ── Provider labels ──────────────────────────────
export const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  claude: 'Anthropic Claude',
}

// ── Model provider inference ────────────────────
export function inferProvider(modelId: string, availableProviders: string[]): string {
  if (
    modelId.startsWith('gpt-') ||
    modelId.startsWith('o1') ||
    modelId.startsWith('o3') ||
    modelId.startsWith('o4')
  )
    return 'openai'
  if (modelId.startsWith('gemini-')) return 'gemini'
  if (modelId.startsWith('claude-')) return 'claude'
  return availableProviders[0] ?? 'openai'
}

// ── Tool display names ──────────────────────────
export const TOOL_DISPLAY_NAMES: Record<string, string> = {
  search_documents: 'Document Search',
  web_search: 'Web Search',
  run_bash: 'Bash',
  run_browser_script: 'Browser',
  discover_tools: 'Tool Discovery',
  run_python: 'Python',
  save_document: 'Save Document',
  generate_file: 'File Generator',
  aws_command: 'AWS CLI',
  kubectl_command: 'Kubectl',
  docker_command: 'Docker',
  delegate_task: 'Sub-Agent',
}

export function formatToolDisplayName(toolName: string): string {
  return (
    TOOL_DISPLAY_NAMES[toolName] ??
    toolName
      .split(/[_-]/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  )
}

// ── Mobile breakpoint ───────────────────────────
export const MOBILE_BREAKPOINT = 768

// ── Onboarding unlockable skills ────────────────
export const ONBOARDING_UNLOCKABLE_SLUGS = [
  'aws-cli',
  'docker',
  'kubectl',
  'gh-cli',
  'browser-automation',
]
