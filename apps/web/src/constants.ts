// ── Polling intervals (ms) ───────────────────────
export const POLL_SESSIONS_FAST_MS = 3000        // when sessions have no title
export const POLL_SESSIONS_NORMAL_MS = 10000
export const POLL_MESSAGES_MS = 10000
export const POLL_ACTIVE_SESSION_MS = 1500
export const POLL_BROWSER_HEALTH_MS = 10000
export const POLL_BROWSER_SESSIONS_MS = 5000
export const POLL_CONTAINER_STATUS_MS = 10000
export const POLL_CRON_JOBS_MS = 15_000
export const POLL_DOCUMENT_STATUS_MS = 2000
export const POLL_DOCKER_IMAGES_MS = 1500

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

// ── Feature flags ────────────────────────────────
export const ALWAYS_ON_CAPABILITY_SLUGS = ['document-search', 'bash', 'file-ops', 'tool-discovery']

// ── Workspace colors ─────────────────────────────
export const WORKSPACE_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e',
  '#f97316', '#eab308', '#22c55e', '#14b8a6',
  '#06b6d4', '#3b82f6',
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

// ── Mobile breakpoint ───────────────────────────
export const MOBILE_BREAKPOINT = 768

// ── Onboarding unlockable skills ────────────────
export const ONBOARDING_UNLOCKABLE_SLUGS = ['aws-cli', 'docker', 'kubectl', 'gh-cli', 'browser-automation']
