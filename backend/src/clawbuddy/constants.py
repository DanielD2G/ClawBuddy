"""Application constants.

Replaces: apps/api/src/constants.ts + packages/shared/src/constants/index.ts
"""

from __future__ import annotations

# ── Timeouts (seconds unless noted) ──────────────────────────
BROWSER_IDLE_TIMEOUT_MS: int = 5 * 60 * 1000  # 5 min
BROWSER_HEALTH_TIMEOUT_MS: int = 5_000
BROWSER_SCRIPT_DEFAULT_TIMEOUT_S: int = 30
BROWSER_SCRIPT_MIN_TIMEOUT_S: int = 5
BROWSER_SCRIPT_MAX_TIMEOUT_S: int = 120
BROWSER_ACTION_TIMEOUT_MS: int = 8_000
BROWSER_NAV_TIMEOUT_MS: int = 15_000

SANDBOX_MAX_TIMEOUT_MS: int = 300_000  # 5 min
SANDBOX_IDLE_TIMEOUT_MS: int = 10 * 60 * 1000  # 10 min
SANDBOX_DEFAULT_EXEC_TIMEOUT_S: int = 30
SANDBOX_STOP_TIMEOUT_S: int = 5

FILE_READ_TIMEOUT_S: int = 10
RECENT_EXECUTION_WINDOW_MS: int = 60_000

# ── Size limits ──────────────────────────────────────────────
MAX_READABLE_CONTENT_BYTES: int = 50 * 1024  # 50 KB
MAX_FILE_UPLOAD_BYTES: int = 20 * 1024 * 1024  # 20 MB
EXEC_OUTPUT_MAX_BYTES: int = 50_000
MAX_SCREENSHOT_SSE_SIZE: int = 500_000

# ── Sandbox resources ────────────────────────────────────────
SANDBOX_MEMORY_BYTES: int = 512 * 1024 * 1024  # 512 MB
SANDBOX_NANOCPUS: int = 1_000_000_000  # 1 CPU
SANDBOX_PID_LIMIT: int = 100
SANDBOX_TIMEOUT_EXIT_CODE: int = 124
SANDBOX_BASE_IMAGE: str = "clawbuddy-sandbox-base"
SANDBOX_FALLBACK_IMAGE: str = "ubuntu:22.04"
SANDBOX_BASE_DOCKERFILE: str = """FROM ubuntu:22.04

RUN apt-get update && apt-get install -y --no-install-recommends \\
    curl wget jq git ca-certificates python3 python3-pip \\
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash sandbox
WORKDIR /workspace
RUN chown sandbox:sandbox /workspace

USER sandbox
CMD ["sleep", "infinity"]"""

# ── Truncation ───────────────────────────────────────────────
OUTPUT_TRUNCATE_THRESHOLD: int = 20_000
TOOL_ARG_SIZE_LIMIT: int = 10_000
LARGE_TOOL_ARG_THRESHOLD: int = 2_000
CHAT_TITLE_MAX_LEN: int = 50
COMPRESSION_PREVIEW_LEN: int = 2_000
CHUNK_PREVIEW_LEN: int = 200
FULL_CONTENT_PREVIEW_LEN: int = 10_000

# ── Browser extraction limits ───────────────────────────────
MAX_LINKS: int = 30
MAX_INTERACTIVE_ELEMENTS: int = 50
LINK_TEXT_MAX_LEN: int = 100
ELEMENT_TEXT_MAX_LEN: int = 80
SELECTOR_TEXT_MAX_LEN: int = 40
INPUT_VALUE_MAX_LEN: int = 100
SCREENSHOT_JPEG_QUALITY: int = 50

# ── Tool result pruning ─────────────────────────────────────
TOOL_RESULT_PROTECTION_WINDOW: int = 10_000
MIN_PRUNE_SIZE: int = 200

# ── Agent ────────────────────────────────────────────────────
DEFAULT_MAX_AGENT_ITERATIONS: int = 50
MAX_AGENT_DOCUMENTS: int = 50

# ── Context compression ─────────────────────────────────────
DEFAULT_MAX_CONTEXT_TOKENS: int = 80_000
RECENT_MESSAGES_TO_KEEP: int = 10
MIN_MESSAGES_FOR_COMPRESSION: int = 6
COMPRESSION_TEMPERATURE: float = 0.2
COMPRESSION_MAX_TOKENS: int = 2_000
TOKEN_ESTIMATION_DIVISOR: int = 4

# ── Title generation ────────────────────────────────────────
TITLE_TEMPERATURE: float = 0.3
TITLE_MAX_TOKENS: int = 30

# ── Pagination ───────────────────────────────────────────────
DEFAULT_PAGE_LIMIT: int = 20
MAX_PAGE_LIMIT: int = 100

# ── Search ───────────────────────────────────────────────────
SEARCH_RESULTS_LIMIT: int = 5
DEFAULT_SEARCH_VECTOR_LIMIT: int = 10

# ── Ingestion ────────────────────────────────────────────────
EMBEDDING_BATCH_SIZE: int = 20
INGESTION_CONCURRENCY: int = 3

# ── LLM defaults ────────────────────────────────────────────
CLAUDE_DEFAULT_MAX_TOKENS: int = 4_096
CLAUDE_DEFAULT_TEMPERATURE: float = 0.7

# ── Docker images ────────────────────────────────────────────
IMAGE_TAG_HASH_LENGTH: int = 12

# ── Tool discovery ───────────────────────────────────────────
TOOL_DISCOVERY_THRESHOLD: int = 6
TOOL_DISCOVERY_TOP_K: int = 3
TOOL_DISCOVERY_COLLECTION: str = "clawbuddy_tools"
TOOL_DISCOVERY_EMBEDDING_INSTRUCTIONS_LIMIT: int = 500
TOOL_DISCOVERY_MAX_CALLS: int = 3
PREFLIGHT_DISCOVERY_SCORE_THRESHOLD: float = 0.55

# ── Sub-agent delegation ────────────────────────────────────
SUB_AGENT_EXPLORE_MAX_ITERATIONS: int = 50
SUB_AGENT_ANALYZE_MAX_ITERATIONS: int = 25
SUB_AGENT_EXECUTE_MAX_ITERATIONS: int = 50

# Tools the main agent cannot use directly - must delegate to a sub-agent
DELEGATION_ONLY_TOOLS: frozenset[str] = frozenset(["run_browser_script"])

# ── Always-allowed tools (no approval needed) ───────────────
ALWAYS_ALLOWED_TOOLS: frozenset[str] = frozenset([
    "search_documents",
    "save_document",
    "generate_file",
    "create_cron",
    "list_crons",
    "delete_cron",
    "web_search",
    "web_fetch",
    "discover_tools",
    "read_file",
])

# ── Parallel tool execution ─────────────────────────────────
PARALLEL_SAFE_TOOLS: frozenset[str] = frozenset([
    "web_search",
    "web_fetch",
    "search_documents",
    "discover_tools",
    "list_crons",
    "delegate_task",
    "read_file",
])

# ── API key masking ─────────────────────────────────────────
KEY_MASK_THRESHOLD: int = 8

# ── Settings validation ─────────────────────────────────────
MIN_CONTEXT_LIMIT_TOKENS: int = 5_000
MAX_CONTEXT_LIMIT_TOKENS: int = 200_000
DEFAULT_CONTEXT_LIMIT_TOKENS: int = 80_000
DEFAULT_BROWSER_GRID_URL: str = "http://localhost:9090"
DEFAULT_BROWSER_TYPE: str = "camoufox"

# ── Shared constants (from packages/shared) ──────────────────
EMBEDDING_DIMENSIONS: dict[str, int] = {
    # OpenAI
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
    # Gemini
    "gemini-embedding-001": 768,
    "gemini-embedding-2-preview": 3072,
}

ALWAYS_ON_CAPABILITY_SLUGS: list[str] = [
    "document-search",
    "agent-memory",
    "cron-management",
    "bash",
    "python",
    "web-fetch",
    "read-file",
    "sub-agent-delegation",
    "tool-discovery",
]

CHUNK_SIZE: int = 512
CHUNK_OVERLAP: int = 50
QDRANT_COLLECTION_NAME: str = "clawbuddy_chunks"
