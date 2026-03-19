// ── Timeouts (milliseconds unless noted) ──────────
export const BROWSER_IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 5 min
export const BROWSER_HEALTH_TIMEOUT_MS = 5000
export const BROWSER_SCRIPT_DEFAULT_TIMEOUT_S = 30
export const BROWSER_SCRIPT_MIN_TIMEOUT_S = 5
export const BROWSER_SCRIPT_MAX_TIMEOUT_S = 120
export const BROWSER_ACTION_TIMEOUT_MS = 8_000 // Playwright locator auto-wait cap
export const BROWSER_NAV_TIMEOUT_MS = 15_000 // page.goto() timeout

export const SANDBOX_MAX_TIMEOUT_MS = 300_000 // 5 min
export const SANDBOX_IDLE_TIMEOUT_MS = 10 * 60 * 1000 // 10 min
export const SANDBOX_DEFAULT_EXEC_TIMEOUT_S = 30
export const SANDBOX_STOP_TIMEOUT_S = 5

export const FILE_READ_TIMEOUT_S = 10
export const RECENT_EXECUTION_WINDOW_MS = 60_000

// ── Size limits ───────────────────────────────────
export const MAX_READABLE_CONTENT_BYTES = 50 * 1024 // 50KB
export const MAX_FILE_UPLOAD_BYTES = 20 * 1024 * 1024 // 20MB
export const EXEC_OUTPUT_MAX_BYTES = 50_000
export const MAX_SCREENSHOT_SSE_SIZE = 500_000

export const SANDBOX_MEMORY_BYTES = 512 * 1024 * 1024 // 512MB
export const SANDBOX_NANOCPUS = 1_000_000_000 // 1 CPU
export const SANDBOX_PID_LIMIT = 100
export const SANDBOX_TIMEOUT_EXIT_CODE = 124
export const SANDBOX_BASE_IMAGE = 'clawbuddy-sandbox-base'
export const SANDBOX_FALLBACK_IMAGE = 'ubuntu:22.04'
export const SANDBOX_BASE_DOCKERFILE = `FROM ubuntu:22.04

RUN apt-get update && apt-get install -y --no-install-recommends \\
    curl wget jq git ca-certificates python3 python3-pip \\
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash sandbox
WORKDIR /workspace
RUN chown sandbox:sandbox /workspace

USER sandbox
CMD ["sleep", "infinity"]`

// ── Truncation ────────────────────────────────────
export const OUTPUT_TRUNCATE_THRESHOLD = 20_000
export const TOOL_ARG_SIZE_LIMIT = 10_000
export const LARGE_TOOL_ARG_THRESHOLD = 2000
export const CHAT_TITLE_MAX_LEN = 50
export const COMPRESSION_PREVIEW_LEN = 2000
export const CHUNK_PREVIEW_LEN = 200
export const FULL_CONTENT_PREVIEW_LEN = 10000

// ── Browser extraction limits ─────────────────────
export const MAX_LINKS = 30
export const MAX_INTERACTIVE_ELEMENTS = 50
export const LINK_TEXT_MAX_LEN = 100
export const ELEMENT_TEXT_MAX_LEN = 80
export const SELECTOR_TEXT_MAX_LEN = 40
export const INPUT_VALUE_MAX_LEN = 100
export const SCREENSHOT_JPEG_QUALITY = 50

// ── Tool result pruning ─────────────────────────
export const TOOL_RESULT_PROTECTION_WINDOW = 10_000 // ~40K chars worth of tokens to protect
export const MIN_PRUNE_SIZE = 200 // don't prune results smaller than this

// ── Agent ─────────────────────────────────────────
export const DEFAULT_MAX_AGENT_ITERATIONS = 50
export const MAX_AGENT_DOCUMENTS = 50

// ── Context compression ──────────────────────────
export const DEFAULT_MAX_CONTEXT_TOKENS = 80_000
export const RECENT_MESSAGES_TO_KEEP = 10
export const MIN_MESSAGES_FOR_COMPRESSION = 6
export const COMPRESSION_TEMPERATURE = 0.2
export const COMPRESSION_MAX_TOKENS = 2000
export const TOKEN_ESTIMATION_DIVISOR = 4

// ── Title generation ─────────────────────────────
export const TITLE_TEMPERATURE = 0.3
export const TITLE_MAX_TOKENS = 30

// ── Pagination ───────────────────────────────────
export const DEFAULT_PAGE_LIMIT = 20
export const MAX_PAGE_LIMIT = 100

// ── Search ───────────────────────────────────────
export const SEARCH_RESULTS_LIMIT = 5
export const DEFAULT_SEARCH_VECTOR_LIMIT = 10

// ── Ingestion ────────────────────────────────────
export const EMBEDDING_BATCH_SIZE = 20
export const INGESTION_CONCURRENCY = 3

// ── LLM defaults ────────────────────────────────
export const CLAUDE_DEFAULT_MAX_TOKENS = 4096
export const CLAUDE_DEFAULT_TEMPERATURE = 0.7

// ── Docker images ───────────────────────────────
export const IMAGE_TAG_HASH_LENGTH = 12

// ── Tool discovery ────────────────────────────────
export const TOOL_DISCOVERY_THRESHOLD = 6
export const TOOL_DISCOVERY_TOP_K = 3
export const TOOL_DISCOVERY_COLLECTION = 'clawbuddy_tools'
export const TOOL_DISCOVERY_EMBEDDING_INSTRUCTIONS_LIMIT = 500
export const TOOL_DISCOVERY_MAX_CALLS = 3
export const PREFLIGHT_DISCOVERY_SCORE_THRESHOLD = 0.55
export const ALWAYS_ON_CAPABILITY_SLUGS = [
  'document-search',
  'agent-memory',
  'bash',
  'python',
  'web-fetch',
  'sub-agent-delegation',
  'tool-discovery',
]

// ── Sub-agent delegation ────────────────────────
export const SUB_AGENT_EXPLORE_MAX_ITERATIONS = 50
export const SUB_AGENT_ANALYZE_MAX_ITERATIONS = 25
export const SUB_AGENT_EXECUTE_MAX_ITERATIONS = 50

/** Tools the main agent cannot use directly — must delegate to a sub-agent */
export const DELEGATION_ONLY_TOOLS = new Set(['run_browser_script'])

// ── Always-allowed tools (no approval needed) ───
export const ALWAYS_ALLOWED_TOOLS = new Set([
  'search_documents', 'save_document', 'generate_file',
  'create_cron', 'list_crons', 'delete_cron', 'web_search', 'web_fetch',
  'discover_tools',
])

// ── Parallel tool execution ─────────────────────
export const PARALLEL_SAFE_TOOLS = new Set([
  'web_search',
  'web_fetch',
  'search_documents',
  'discover_tools',
  'list_crons',
  'delegate_task',
])

// ── API key masking ─────────────────────────────
export const KEY_MASK_THRESHOLD = 8

// ── Settings validation ─────────────────────────
export const MIN_CONTEXT_LIMIT_TOKENS = 5000
export const MAX_CONTEXT_LIMIT_TOKENS = 200000
export const DEFAULT_CONTEXT_LIMIT_TOKENS = 80000
export const DEFAULT_BROWSER_GRID_URL = 'http://localhost:9090'
export const DEFAULT_BROWSER_TYPE = 'camoufox'
