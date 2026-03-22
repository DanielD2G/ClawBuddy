"""Tool executor service — routes tool calls to their handlers and records results.

Replaces: apps/api/src/services/tool-executor.service.ts
"""

from __future__ import annotations

import base64
import json
import posixpath
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.constants import (
    ALWAYS_ON_CAPABILITY_SLUGS,
    DELEGATION_ONLY_TOOLS,
    SEARCH_RESULTS_LIMIT,
)
from clawbuddy.db.models import (
    Capability,
    Document,
    DocumentChunk,
    Folder,
    ToolExecution,
    WorkspaceCapability,
)
from clawbuddy.lib.html_to_markdown import html_to_markdown, html_to_text
from clawbuddy.lib.sanitize import strip_null_bytes
from clawbuddy.lib.screenshot import extract_screenshot_base64
from clawbuddy.lib.url_safety import is_private_host
from clawbuddy.services.secret_redaction import (
    SecretInventory,
    secret_redaction_service,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

BINARY_EXTENSIONS = frozenset({
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "ico",
    "pdf", "zip", "tar", "gz",
    "mp3", "mp4", "wav", "ogg",
    "woff", "woff2", "ttf", "otf",
})

MIME_TYPES: dict[str, str] = {
    "csv": "text/csv",
    "md": "text/markdown",
    "txt": "text/plain",
    "json": "application/json",
    "html": "text/html",
    "xml": "application/xml",
    "yaml": "text/yaml",
    "yml": "text/yaml",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "webp": "image/webp",
    "pdf": "application/pdf",
    "zip": "application/zip",
}


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

@dataclass
class ExecutionContext:
    """Context for tool execution."""
    workspace_id: str
    chat_session_id: str
    db: AsyncSession
    secret_inventory: SecretInventory | None = None
    browser_session_id: str | None = None
    capability: dict[str, Any] | None = None
    emit: Callable[..., Awaitable[None]] | None = None
    capabilities: list[dict[str, Any]] | None = None
    mentioned_slugs: list[str] | None = None
    abort_event: Any | None = None  # asyncio.Event


@dataclass
class DocumentSource:
    """A source document reference from search results."""
    document_id: str
    document_title: str
    workspace_id: str | None = None
    chunk_id: str = ""
    chunk_index: int = 0


@dataclass
class ExecutionResult:
    """Result of executing a tool."""
    output: str
    error: str | None = None
    exit_code: int | None = None
    duration_ms: int = 0
    sources: list[DocumentSource] | None = None
    execution_id: str | None = None
    sub_agent_execution_ids: list[str] | None = None


# ---------------------------------------------------------------------------
# Tool handlers
# ---------------------------------------------------------------------------

async def _execute_document_search(
    args: dict[str, Any],
    ctx: ExecutionContext,
) -> ExecutionResult:
    """Execute document search (RAG pipeline)."""
    start = time.monotonic()

    from clawbuddy.services.embedding import embedding_service
    from clawbuddy.services.search import search_service

    query = str(args.get("query", ""))
    document_ids: list[str] | None = args.get("documentIds")

    query_vector = await embedding_service.embed(query)
    search_results = await search_service.search(
        query_vector,
        limit=SEARCH_RESULTS_LIMIT,
        workspace_id=ctx.workspace_id,
        document_ids=document_ids,
    )

    # Fallback: search without workspace filter
    if not search_results:
        search_results = await search_service.search(
            query_vector,
            limit=SEARCH_RESULTS_LIMIT,
            document_ids=document_ids,
        )

    chunk_ids = [
        r.payload.get("chunkId")
        for r in search_results
        if hasattr(r, "payload") and r.payload and r.payload.get("chunkId")
    ]

    db = ctx.db
    chunks: list[Any] = []
    if chunk_ids:
        from sqlalchemy.orm import selectinload

        result = await db.execute(
            select(DocumentChunk)
            .options(selectinload(DocumentChunk.document))
            .where(DocumentChunk.id.in_(chunk_ids))
        )
        chunks = list(result.scalars().all())

    # Fallback by qdrant ID
    if not chunks and search_results:
        qdrant_ids = [str(r.id) for r in search_results if r.id]
        if qdrant_ids:
            from sqlalchemy.orm import selectinload

            result = await db.execute(
                select(DocumentChunk)
                .options(selectinload(DocumentChunk.document))
                .where(DocumentChunk.qdrant_id.in_(qdrant_ids))
            )
            chunks = list(result.scalars().all())

    duration_ms = int((time.monotonic() - start) * 1000)

    if not chunks:
        return ExecutionResult(
            output="No relevant documents found for this query.",
            duration_ms=duration_ms,
        )

    output = "\n\n---\n\n".join(
        f"[Source: {c.document.title}]\n{c.content}" for c in chunks
    )

    seen: set[str] = set()
    sources: list[DocumentSource] = []
    for c in chunks:
        if c.document.id not in seen:
            seen.add(c.document.id)
            sources.append(
                DocumentSource(
                    document_id=c.document.id,
                    document_title=c.document.title,
                    workspace_id=ctx.workspace_id,
                    chunk_id=c.id,
                    chunk_index=c.chunk_index,
                )
            )

    return ExecutionResult(output=output, duration_ms=duration_ms, sources=sources)


async def _execute_web_fetch(args: dict[str, Any]) -> ExecutionResult:
    """Fetch a URL and return content, converting HTML to Markdown."""
    import httpx

    start = time.monotonic()

    def _fail(error: str) -> ExecutionResult:
        return ExecutionResult(
            output="",
            error=error,
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    url = str(args.get("url", ""))
    format_raw = str(args.get("format", "markdown")).lower()
    if format_raw not in ("markdown", "text", "html"):
        return _fail(f'Invalid format "{format_raw}" — must be markdown, text, or html')

    method = str(args.get("method", "GET")).upper()
    custom_headers = args.get("headers") or {}
    body = args.get("body")
    max_bytes = min(int(args.get("maxKb") or 100) * 1024, 5 * 1024 * 1024)

    # Validate URL
    from urllib.parse import urlparse

    try:
        parsed = urlparse(url)
    except Exception:
        return _fail("Invalid URL")

    if parsed.scheme not in ("http", "https"):
        return _fail("Only http/https URLs are supported")

    hostname = parsed.hostname or ""
    if is_private_host(hostname):
        return _fail("Requests to private/internal addresses are blocked")

    try:
        headers = {
            "User-Agent": "ClawBuddy/1.0",
            "Accept": "text/html,application/xhtml+xml,*/*",
            **custom_headers,
        }
        content_body = body if method in ("POST", "PUT", "PATCH") else None

        async with httpx.AsyncClient(
            follow_redirects=True, timeout=30.0
        ) as client:
            response = await client.request(
                method, url, headers=headers, content=content_body
            )

        raw_bytes = response.content[:max_bytes]
        truncated = len(response.content) > max_bytes
        raw_text = raw_bytes.decode("utf-8", errors="replace")

        content_type = response.headers.get("content-type", "")
        is_html = "text/html" in content_type or "application/xhtml" in content_type

        if is_html and format_raw == "markdown":
            content = html_to_markdown(raw_text)
        elif is_html and format_raw == "text":
            content = html_to_text(raw_text)
        else:
            content = raw_text

        if truncated:
            content += f"\n\n[... truncated at {max_bytes // 1024} KB]"

        output = json.dumps({
            "status": response.status_code,
            "statusText": response.reason_phrase,
            "contentType": content_type,
            "body": content,
        })

        return ExecutionResult(
            output=output,
            duration_ms=int((time.monotonic() - start) * 1000),
        )
    except Exception as e:
        return _fail(f"Fetch failed: {e}")


async def _execute_save_document(
    args: dict[str, Any],
    ctx: ExecutionContext,
) -> ExecutionResult:
    """Save a document to the agent's knowledge base."""
    start = time.monotonic()
    db = ctx.db
    title = str(args.get("title", "Untitled"))
    content = str(args.get("content", ""))

    # Get or create the __agent__ folder
    result = await db.execute(
        select(Folder).where(
            Folder.workspace_id == ctx.workspace_id,
            Folder.name == "__agent__",
            Folder.parent_id.is_(None),
        )
    )
    agent_folder = result.scalar_one_or_none()
    if not agent_folder:
        agent_folder = Folder(
            name="__agent__",
            workspace_id=ctx.workspace_id,
        )
        db.add(agent_folder)
        await db.flush()

    doc = Document(
        title=title,
        content=content,
        type="MARKDOWN",
        status="PENDING",
        workspace_id=ctx.workspace_id,
        folder_id=agent_folder.id,
    )
    db.add(doc)
    await db.flush()

    # Trigger ingestion
    from clawbuddy.services.ingestion import ingestion_service

    await ingestion_service.enqueue(doc.id)

    return ExecutionResult(
        output=f'Document "{title}" saved successfully (id: {doc.id}). It will be indexed for search shortly.',
        duration_ms=int((time.monotonic() - start) * 1000),
    )


async def _execute_generate_file(
    args: dict[str, Any],
    ctx: ExecutionContext,
) -> ExecutionResult:
    """Generate a downloadable file and return a download URL."""
    start = time.monotonic()
    filename = str(args.get("filename", "file.txt"))
    source_path = args.get("sourcePath")

    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "txt"
    is_binary = ext in BINARY_EXTENSIONS

    from clawbuddy.services.sandbox import sandbox_service
    from clawbuddy.services.storage import storage_service

    file_bytes: bytes

    if source_path:
        if not ctx.workspace_id:
            return ExecutionResult(
                output="",
                error="sourcePath requires an active sandbox. Use content parameter instead.",
                duration_ms=int((time.monotonic() - start) * 1000),
            )
        user_home = "/workspace"
        resolved = source_path if source_path.startswith("/") else f"{user_home}/{source_path}"

        if is_binary:
            try:
                file_bytes = await sandbox_service.read_file_from_container(
                    ctx.workspace_id, resolved
                )
            except Exception:
                basename = posixpath.basename(source_path)
                fallback = f"{user_home}/{basename}"
                if resolved != fallback:
                    try:
                        file_bytes = await sandbox_service.read_file_from_container(
                            ctx.workspace_id, fallback
                        )
                    except Exception as e:
                        return ExecutionResult(
                            output="",
                            error=f"Failed to read {source_path}: {e}. Working directory is {user_home}/.",
                            duration_ms=int((time.monotonic() - start) * 1000),
                        )
                else:
                    return ExecutionResult(
                        output="",
                        error=f"Failed to read {source_path}. Working directory is {user_home}/.",
                        duration_ms=int((time.monotonic() - start) * 1000),
                    )
        else:
            result = await sandbox_service.exec_in_workspace(
                ctx.workspace_id, f"cat {json.dumps(resolved)}", timeout=10
            )
            if result.exit_code != 0:
                basename = posixpath.basename(source_path)
                fallback = f"{user_home}/{basename}"
                if resolved != fallback:
                    fallback_result = await sandbox_service.exec_in_workspace(
                        ctx.workspace_id, f"cat {json.dumps(fallback)}", timeout=10
                    )
                    if fallback_result.exit_code == 0:
                        result = fallback_result
                if result.exit_code != 0:
                    return ExecutionResult(
                        output="",
                        error=f"Failed to read {source_path}: {result.stderr}. Working directory is {user_home}/.",
                        duration_ms=int((time.monotonic() - start) * 1000),
                    )
            file_bytes = result.stdout.encode("utf-8")

    elif args.get("content"):
        file_bytes = str(args["content"]).encode("utf-8")
    else:
        return ExecutionResult(
            output="",
            error="Either content or sourcePath must be provided",
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    key = f"generated/{int(time.time() * 1000)}-{filename}"
    content_type = MIME_TYPES.get(ext, "application/octet-stream")
    await storage_service.upload(key, file_bytes, content_type)

    download_url = f"/api/files/{key}"

    return ExecutionResult(
        output=json.dumps({"filename": filename, "downloadUrl": download_url}),
        duration_ms=int((time.monotonic() - start) * 1000),
    )


async def _execute_create_cron(
    args: dict[str, Any],
    ctx: ExecutionContext,
) -> ExecutionResult:
    """Create a cron job via agent tool call."""
    start = time.monotonic()

    from clawbuddy.services.cron import cron_service

    job = await cron_service.create(
        db=ctx.db,
        name=str(args.get("name", "Unnamed cron")),
        schedule=str(args.get("schedule", "*/30 * * * *")),
        prompt=str(args.get("prompt", "")),
        job_type="agent",
        workspace_id=ctx.workspace_id,
        session_id=ctx.chat_session_id,
    )

    return ExecutionResult(
        output=f'Cron job "{job.name}" created successfully (id: {job.id}, schedule: {job.schedule}). It will run in this conversation on the specified schedule.',
        duration_ms=int((time.monotonic() - start) * 1000),
    )


async def _execute_list_crons(ctx: ExecutionContext) -> ExecutionResult:
    """List all cron jobs."""
    start = time.monotonic()

    from clawbuddy.services.cron import cron_service

    jobs = await cron_service.list_all(ctx.db)

    if not jobs:
        return ExecutionResult(
            output="No cron jobs configured.",
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    lines: list[str] = []
    for j in jobs:
        last_run = j.last_run_at.isoformat() if j.last_run_at else "never"
        lines.append(
            f"- **{j.name}** (id: {j.id})\n"
            f"  Schedule: {j.schedule} | Type: {j.type} | Enabled: {j.enabled}\n"
            f"  Last run: {last_run} ({j.last_run_status or 'n/a'})"
        )

    return ExecutionResult(
        output="\n\n".join(lines),
        duration_ms=int((time.monotonic() - start) * 1000),
    )


async def _execute_delete_cron(
    args: dict[str, Any],
    ctx: ExecutionContext,
) -> ExecutionResult:
    """Delete a cron job by ID."""
    start = time.monotonic()

    from clawbuddy.services.cron import cron_service

    cron_id = str(args.get("id", ""))
    try:
        await cron_service.delete(ctx.db, cron_id)
        return ExecutionResult(
            output=f"Cron job {cron_id} deleted successfully.",
            duration_ms=int((time.monotonic() - start) * 1000),
        )
    except Exception as e:
        return ExecutionResult(
            output="",
            error=str(e),
            duration_ms=int((time.monotonic() - start) * 1000),
        )


async def _execute_web_search(args: dict[str, Any]) -> ExecutionResult:
    """Web search using Gemini's Google Search grounding."""
    start = time.monotonic()
    query = str(args.get("query", "")).strip()

    if not query:
        return ExecutionResult(
            output="",
            error="Search query is required",
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    from clawbuddy.services.settings_service import settings_service

    api_key = await settings_service.get_api_key("gemini")
    if not api_key:
        return ExecutionResult(
            output="",
            error="Web search requires a Gemini API key. Please configure it in Settings.",
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=api_key)
        result = await client.aio.models.generate_content(
            model="gemini-2.5-flash",
            contents=query,
            config=types.GenerateContentConfig(
                tools=[types.Tool(googleSearch=types.GoogleSearch())]
            ),
        )
        text = result.text or ""

        # Extract grounding metadata
        sources_text = ""
        candidates = getattr(result, "candidates", None) or []
        candidate = candidates[0] if candidates else None
        grounding_meta = getattr(candidate, "grounding_metadata", None)
        if grounding_meta:
            chunks = getattr(grounding_meta, "grounding_chunks", []) or []
            source_lines: list[str] = []
            for chunk in chunks:
                web = getattr(chunk, "web", None)
                if web:
                    source_lines.append(f"- [{web.title}]({web.uri})")
            if source_lines:
                sources_text = "\n\n**Sources:**\n" + "\n".join(source_lines)

        return ExecutionResult(
            output=text + sources_text,
            duration_ms=int((time.monotonic() - start) * 1000),
        )
    except Exception as e:
        return ExecutionResult(
            output="",
            error=f"Web search failed: {e}",
            duration_ms=int((time.monotonic() - start) * 1000),
        )


async def _execute_browser_script(
    args: dict[str, Any],
    ctx: ExecutionContext,
) -> ExecutionResult:
    """Execute a Playwright script via BrowserGrid."""
    start = time.monotonic()
    script = str(args.get("script", "")).strip()
    timeout = min(max(int(args.get("timeout") or 30), 5), 120)

    if not script:
        return ExecutionResult(
            output="",
            error="Script is required",
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    from clawbuddy.services.browser import browser_service

    session_key = ctx.browser_session_id or ctx.chat_session_id
    result = await browser_service.execute_script(session_key, script, timeout)

    if result.success:
        output = result.result or "Script completed."

        # Handle save screenshot response
        try:
            parsed = json.loads(output)
            if isinstance(parsed, dict) and parsed.get("__saveScreenshot"):
                if not ctx.workspace_id:
                    return ExecutionResult(
                        output="",
                        error="saveScreenshot() requires an active sandbox session.",
                        duration_ms=int((time.monotonic() - start) * 1000),
                    )

                from clawbuddy.services.sandbox import sandbox_service

                screenshot_b64 = parsed.get("screenshot") or ""
                if not screenshot_b64:
                    extracted = extract_screenshot_base64(output)
                    screenshot_b64 = extracted.screenshot_b64 or ""

                if not screenshot_b64:
                    return ExecutionResult(
                        output="",
                        error="saveScreenshot() did not produce screenshot data.",
                        duration_ms=int((time.monotonic() - start) * 1000),
                    )

                suggested_name = parsed.get("filename", "").strip()
                if not suggested_name:
                    suggested_name = f"browser-screenshot-{uuid.uuid4()}.jpg"
                base_name = suggested_name.rsplit(".", 1)[0] if "." in suggested_name else suggested_name
                resolved_path = f"/workspace/screenshots/{base_name}-{uuid.uuid4()}.jpg"

                try:
                    image_buffer = base64.b64decode(screenshot_b64)
                    await sandbox_service.write_file_to_container(
                        ctx.workspace_id, resolved_path, image_buffer
                    )
                except Exception as e:
                    return ExecutionResult(
                        output="",
                        error=f"Failed to save screenshot to {resolved_path}: {e}",
                        duration_ms=int((time.monotonic() - start) * 1000),
                    )

                parsed.pop("__saveScreenshot", None)
                parsed.pop("screenshot", None)
                parsed.pop("filename", None)
                parsed["savedPath"] = resolved_path
                output = json.dumps(parsed, indent=2)
        except (json.JSONDecodeError, TypeError):
            pass

        return ExecutionResult(
            output=output,
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    # Error case
    error_msg = result.error or "Unknown browser error"
    output = f"Error: {error_msg}"

    screenshot_b64 = result.screenshot_base64
    if screenshot_b64:
        output = json.dumps({
            "error": error_msg,
            "screenshot": screenshot_b64,
            "description": f"Browser script failed: {error_msg}. Screenshot of current page state attached.",
        })

    return ExecutionResult(
        output=output,
        error=error_msg,
        duration_ms=int((time.monotonic() - start) * 1000),
    )


async def _execute_discover_tools(
    args: dict[str, Any],
    ctx: ExecutionContext,
) -> ExecutionResult:
    """Discover tools via semantic search or list all available."""
    start = time.monotonic()

    from clawbuddy.services.tool_discovery import tool_discovery_service

    # Get enabled capability slugs excluding always-on
    db = ctx.db
    result = await db.execute(
        select(WorkspaceCapability)
        .join(Capability)
        .where(
            WorkspaceCapability.workspace_id == ctx.workspace_id,
            WorkspaceCapability.enabled == True,
        )
    )
    wcs = result.scalars().all()

    # We need the capability slugs
    enabled_slugs: list[str] = []
    for wc in wcs:
        cap_result = await db.execute(
            select(Capability.slug).where(Capability.id == wc.capability_id)
        )
        slug = cap_result.scalar_one_or_none()
        if slug and slug not in ALWAYS_ON_CAPABILITY_SLUGS:
            enabled_slugs.append(slug)

    if args.get("list_all"):
        listing = await tool_discovery_service.list_available(enabled_slugs)
        return ExecutionResult(
            output=json.dumps({"type": "tool_listing", "available": listing}),
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    query = str(args.get("query", ""))
    discovered = await tool_discovery_service.search(query, enabled_slugs)

    if not discovered:
        return ExecutionResult(
            output=json.dumps({
                "type": "discovery_result",
                "discovered": [],
                "hint": "No matching tools found. Try calling discover_tools with list_all: true to see all available capabilities.",
            }),
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    # Annotate delegation-only tools
    annotated = []
    for cap in discovered:
        tools = []
        for tool in cap.tools:
            if tool.get("name") in DELEGATION_ONLY_TOOLS:
                tool = {
                    **tool,
                    "description": f"[DELEGATION-ONLY — use delegate_task] {tool['description']}",
                }
            tools.append(tool)
        annotated.append({
            "slug": cap.slug,
            "name": cap.name,
            "tools": tools,
            "instructions": cap.instructions,
        })

    return ExecutionResult(
        output=json.dumps({"type": "discovery_result", "discovered": annotated}),
        duration_ms=int((time.monotonic() - start) * 1000),
    )


async def _execute_delegate_task(
    args: dict[str, Any],
    ctx: ExecutionContext,
    tool_call_id: str,
) -> ExecutionResult:
    """Delegate a task to a sub-agent."""
    start = time.monotonic()

    role = args.get("role", "")
    task = args.get("task", "")

    if not role or not task:
        return ExecutionResult(
            output="",
            error="Both role and task are required",
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    valid_roles = ("explore", "analyze", "execute")
    if role not in valid_roles:
        return ExecutionResult(
            output="",
            error=f'Invalid role: "{role}". Must be one of: {", ".join(valid_roles)}',
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    inventory = ctx.secret_inventory
    if not inventory:
        inventory = await secret_redaction_service.build_secret_inventory(
            ctx.db, ctx.workspace_id
        )

    browser_session_id = f"sub-{tool_call_id}"

    # Resolve mentioned slugs to preferred tools
    preferred_tools: list[str] | None = None
    if ctx.mentioned_slugs and ctx.capabilities:
        mentioned_set = set(ctx.mentioned_slugs)
        preferred_tools = []
        for cap in ctx.capabilities:
            if cap.get("slug") in mentioned_set:
                for t in cap.get("toolDefinitions", []) or []:
                    if isinstance(t, dict):
                        preferred_tools.append(t.get("name", ""))
        if not preferred_tools:
            preferred_tools = None

    # Import and run sub-agent
    from clawbuddy.graph.sub_agent_graph import run_sub_agent

    sub_result = await run_sub_agent(
        role=role,
        task=task,
        context=args.get("context"),
        workspace_id=ctx.workspace_id,
        session_id=ctx.chat_session_id,
        db=ctx.db,
        secret_inventory=inventory,
        emit=ctx.emit,
        capabilities=ctx.capabilities,
        sub_agent_id=tool_call_id,
        browser_session_id=browser_session_id,
        preferred_tools=preferred_tools,
        abort_event=ctx.abort_event,
    )

    # Cleanup browser session
    try:
        from clawbuddy.services.browser import browser_service
        await browser_service.close_session(browser_session_id)
    except Exception:
        pass

    # Persist sub-agent tool executions
    sub_agent_execution_ids: list[str] = []
    for te in sub_result.get("toolExecutions", []):
        execution = ToolExecution(
            capability_slug=te.get("capabilitySlug", ""),
            tool_name=te.get("toolName", ""),
            input=te.get("input", {}),
            output=te.get("output"),
            error=te.get("error"),
            duration_ms=te.get("durationMs", 0),
            status="failed" if te.get("error") else "completed",
        )
        ctx.db.add(execution)
        await ctx.db.flush()
        sub_agent_execution_ids.append(execution.id)

    # Build output
    token_info = ""
    if sub_result.get("tokenUsage"):
        tu = sub_result["tokenUsage"]
        token_info = f"Tokens: {tu.get('inputTokens', 0)} in / {tu.get('outputTokens', 0)} out"

    output_lines = [
        f"## Sub-Agent Result ({sub_result.get('role', role)})",
        "",
        sub_result.get("result", ""),
        "",
        "---",
        f"Iterations: {sub_result.get('iterationsUsed', 0)} | Tools used: {len(sub_result.get('toolExecutions', []))} | Success: {sub_result.get('success', False)}",
    ]
    if token_info:
        output_lines.append(token_info)

    return ExecutionResult(
        output="\n".join(output_lines),
        error=None if sub_result.get("success") else "Sub-agent did not complete successfully",
        duration_ms=int((time.monotonic() - start) * 1000),
        sub_agent_execution_ids=sub_agent_execution_ids or None,
    )


async def _execute_read_file(
    args: dict[str, Any],
    ctx: ExecutionContext,
) -> ExecutionResult:
    """Read a file with line numbers, pagination, and binary detection."""
    start = time.monotonic()

    def _fail(error: str) -> ExecutionResult:
        return ExecutionResult(
            output="",
            error=error,
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    file_path = str(args.get("file_path", "")).strip()
    if not file_path:
        return _fail("file_path is required.")

    offset = max(1, int(args.get("offset") or 1))
    limit = min(2000, max(1, int(args.get("limit") or 2000)))
    end_line = offset + limit - 1

    if not ctx.workspace_id:
        return _fail("read_file requires an active sandbox session.")

    from clawbuddy.services.sandbox import sandbox_service

    user_home = "/workspace"
    resolved = file_path if file_path.startswith("/") else f"{user_home}/{file_path}"

    # Build shell script
    script = "\n".join([
        "set -e",
        f"FILE={json.dumps(resolved)}",
        'if [ ! -e "$FILE" ]; then echo "@@NOT_FOUND@@"; exit 0; fi',
        'if [ -d "$FILE" ]; then echo "@@IS_DIRECTORY@@"; exit 0; fi',
        'ENCODING=$(file --mime-encoding -b "$FILE" 2>/dev/null || echo "unknown")',
        'if echo "$ENCODING" | grep -qi "binary"; then echo "@@BINARY@@"; exit 0; fi',
        'if [ ! -s "$FILE" ]; then echo "@@EMPTY@@"; exit 0; fi',
        'TOTAL=$(wc -l < "$FILE")',
        'echo "@@TOTAL:$TOTAL@@"',
        f"awk 'NR >= {offset} && NR <= {end_line} {{",
        "  line = $0",
        '  if (length(line) > 2000) line = substr(line, 1, 2000) "... [truncated]"',
        '  printf "%6d\\t%s\\n", NR, line',
        "}' \"$FILE\"",
    ])

    result = await sandbox_service.exec_in_workspace(ctx.workspace_id, script, timeout=15)

    # Fallback
    if result.exit_code != 0:
        basename = posixpath.basename(file_path)
        fallback = f"{user_home}/{basename}"
        if resolved != fallback:
            fallback_script = script.replace(
                f"FILE={json.dumps(resolved)}",
                f"FILE={json.dumps(fallback)}",
            )
            fallback_result = await sandbox_service.exec_in_workspace(
                ctx.workspace_id, fallback_script, timeout=15
            )
            if fallback_result.exit_code == 0:
                result = fallback_result

    if result.exit_code != 0:
        return _fail(
            f"Failed to read file: {result.stderr or 'unknown error'}. "
            f"Working directory is {user_home}/."
        )

    stdout = result.stdout

    # Handle sentinels
    if stdout.startswith("@@NOT_FOUND@@"):
        return _fail(f"File not found: {file_path}")
    if stdout.startswith("@@IS_DIRECTORY@@"):
        return _fail(f"{file_path} is a directory, not a file. Use bash with `ls` to list directory contents.")
    if stdout.startswith("@@BINARY@@"):
        return _fail(f"{file_path} is a binary file and cannot be displayed as text.")
    if stdout.startswith("@@EMPTY@@"):
        return ExecutionResult(
            output=f"{file_path} is empty (0 lines).",
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    # Parse total and content
    import re

    total_match = re.search(r"^@@TOTAL:(\d+)@@$", stdout, re.MULTILINE)
    total_lines = int(total_match.group(1)) if total_match else 0
    content = re.sub(r"^@@TOTAL:\d+@@\n?", "", stdout)

    # Size guard (20 KB)
    max_output = 20_000
    if len(content) > max_output:
        content = content[:max_output] + "\n... [output truncated at 20 KB]"

    actual_end = min(end_line, total_lines)
    header = f"[File: {file_path}] [Lines: {offset}-{actual_end} of {total_lines}]"
    if end_line < total_lines:
        header += f" (use offset={end_line + 1} to see more)"

    return ExecutionResult(
        output=f"{header}\n{content}",
        duration_ms=int((time.monotonic() - start) * 1000),
    )


async def _resolve_skill_command(
    tool_name: str,
    args: dict[str, Any],
    capability_slug: str,
    preloaded_capability: dict[str, Any] | None,
    db: AsyncSession,
) -> str:
    """Resolve a dynamic skill tool name to a shell command."""
    skill_type: str | None = None
    tool_definitions: Any = None

    if preloaded_capability:
        skill_type = preloaded_capability.get("skillType")
        tool_definitions = preloaded_capability.get("toolDefinitions")
    else:
        result = await db.execute(
            select(Capability).where(Capability.slug == capability_slug)
        )
        cap = result.scalar_one_or_none()
        if cap:
            skill_type = cap.skill_type
            tool_definitions = cap.tool_definitions

    if not skill_type:
        return ""

    # Look up tool definition for prefix/script
    tool_defs = tool_definitions or []
    tool_def = next((t for t in tool_defs if t.get("name") == tool_name), None)
    prefix = tool_def.get("prefix", "") if tool_def else ""

    # Script-based tools
    if tool_def and tool_def.get("script"):
        ext_map = {"python": "py", "js": "mjs", "bash": "sh"}
        runtime_map = {"python": "python3", "js": "node", "bash": "bash"}
        ext = ext_map.get(skill_type, "sh")
        runtime = runtime_map.get(skill_type, "bash")
        script_path = f"/tmp/_skill_{tool_name}.{ext}"

        # Collect CLI args
        param_def = tool_def.get("parameters", {})
        required_keys = param_def.get("required", [])
        all_keys = [
            *required_keys,
            *(k for k in args if k not in required_keys and k != "timeout"),
        ]
        cli_args = " ".join(
            json.dumps(str(v))
            for k in all_keys
            if (v := args.get(k)) is not None
        )

        write_cmd = f"cat > {script_path} << 'SKILL_SCRIPT_EOF'\n{tool_def['script']}\nSKILL_SCRIPT_EOF"
        return f"{write_cmd}\n{runtime} {script_path} {cli_args}"

    # Standard skill execution
    match skill_type:
        case "bash":
            raw = str(args.get("command") or args.get("code") or "")
            return f"{prefix} {raw}" if prefix else raw
        case "python":
            code = str(args.get("code") or args.get("command") or "")
            b64 = base64.b64encode(code.encode()).decode()
            return f"echo '{b64}' | base64 -d | python3"
        case "js":
            code = str(args.get("code") or args.get("command") or "")
            b64 = base64.b64encode(code.encode()).decode()
            return f"echo '{b64}' | base64 -d | node"
        case _:
            return ""


async def _execute_sandbox_command(
    tool_name: str,
    args: dict[str, Any],
    capability_slug: str,
    ctx: ExecutionContext,
) -> ExecutionResult:
    """Execute a command in the sandbox."""
    start = time.monotonic()

    if not ctx.workspace_id:
        return ExecutionResult(
            output="",
            error="No workspace context available. Sandbox capabilities require a workspace.",
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    from clawbuddy.services.sandbox import sandbox_service

    match tool_name:
        case "run_bash":
            command = str(args.get("command", ""))
        case "run_python":
            code = str(args.get("code", ""))
            b64 = base64.b64encode(code.encode()).decode()
            command = f"echo '{b64}' | base64 -d | python3"
        case "run_js":
            code = str(args.get("code", ""))
            b64 = base64.b64encode(code.encode()).decode()
            command = f"echo '{b64}' | base64 -d | node"
        case _:
            command = await _resolve_skill_command(
                tool_name, args, capability_slug, ctx.capability, ctx.db
            )
            if not command:
                return ExecutionResult(
                    output="",
                    error=f"Unsupported sandbox tool: {tool_name}",
                    duration_ms=int((time.monotonic() - start) * 1000),
                )

    user_home = "/workspace"
    timeout = int(args.get("timeout") or 30)
    working_dir = str(args.get("workingDir") or user_home)

    result = await sandbox_service.exec_in_workspace(
        ctx.workspace_id, command, timeout=timeout, working_dir=working_dir
    )

    stdout = strip_null_bytes(result.stdout) if result.stdout else ""
    stderr = strip_null_bytes(result.stderr) if result.stderr else ""

    output_parts = [
        f"stdout:\n{stdout}" if stdout else "",
        f"stderr:\n{stderr}" if stderr else "",
        f"exit code: {result.exit_code}",
    ]
    output = "\n\n".join(p for p in output_parts if p)

    return ExecutionResult(
        output=output,
        error=(stderr or f"Command failed with exit code {result.exit_code}")
        if result.exit_code != 0
        else None,
        exit_code=result.exit_code,
        duration_ms=int((time.monotonic() - start) * 1000),
    )


# ---------------------------------------------------------------------------
# Non-sandbox tools set
# ---------------------------------------------------------------------------

_NON_SANDBOX_TOOLS = frozenset({
    "search_documents",
    "save_document",
    "generate_file",
    "read_file",
    "create_cron",
    "list_crons",
    "delete_cron",
    "web_search",
    "web_fetch",
    "run_browser_script",
    "discover_tools",
    "delegate_task",
})


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------

class ToolExecutorService:
    """Executes tool calls, routing to appropriate handlers."""

    async def execute(
        self,
        tool_name: str,
        tool_call_id: str,
        arguments: dict[str, Any],
        capability_slug: str,
        ctx: ExecutionContext,
    ) -> ExecutionResult:
        """Execute a tool call, routing to the appropriate handler."""
        start = time.monotonic()
        inventory = ctx.secret_inventory
        if not inventory:
            inventory = await secret_redaction_service.build_secret_inventory(
                ctx.db, ctx.workspace_id
            )

        public_input = secret_redaction_service.redact_for_public_storage(
            arguments, inventory
        )

        try:
            # Route to handler
            match tool_name:
                case "search_documents":
                    result = await _execute_document_search(arguments, ctx)
                case "save_document":
                    result = await _execute_save_document(arguments, ctx)
                case "generate_file":
                    result = await _execute_generate_file(arguments, ctx)
                case "read_file":
                    result = await _execute_read_file(arguments, ctx)
                case "create_cron":
                    result = await _execute_create_cron(arguments, ctx)
                case "list_crons":
                    result = await _execute_list_crons(ctx)
                case "delete_cron":
                    result = await _execute_delete_cron(arguments, ctx)
                case "web_search":
                    result = await _execute_web_search(arguments)
                case "web_fetch":
                    result = await _execute_web_fetch(arguments)
                case "run_browser_script":
                    result = await _execute_browser_script(arguments, ctx)
                case "discover_tools":
                    result = await _execute_discover_tools(arguments, ctx)
                case "delegate_task":
                    result = await _execute_delegate_task(arguments, ctx, tool_call_id)
                case _:
                    result = await _execute_sandbox_command(
                        tool_name, arguments, capability_slug, ctx
                    )

            # Extract screenshot from browser output
            screenshot_data: str | None = None
            output_for_db = result.output
            if tool_name == "run_browser_script" and result.output:
                extracted = extract_screenshot_base64(result.output)
                if extracted.screenshot_b64:
                    screenshot_data = f"data:image/jpeg;base64,{extracted.screenshot_b64}"
                    output_for_db = extracted.description or "Screenshot captured"

            # Redact for public display/storage
            public_output = (
                secret_redaction_service.redact_serialized_text(
                    result.output, inventory, skip_keys={"screenshot"}
                )
                if result.output
                else ""
            )
            public_db_output = (
                secret_redaction_service.redact_serialized_text(
                    output_for_db, inventory, skip_keys={"screenshot"}
                )
                if output_for_db
                else None
            )
            public_error = (
                secret_redaction_service.redact_serialized_text(
                    result.error, inventory, skip_keys={"screenshot"}
                )
                if result.error
                else None
            )

            # Record execution
            def _strip_or_none(s: str | None) -> str | None:
                return strip_null_bytes(s) if s else None

            execution = ToolExecution(
                capability_slug=capability_slug,
                tool_name=tool_name,
                input=public_input,
                output=_strip_or_none(public_db_output),
                screenshot=screenshot_data,
                error=_strip_or_none(public_error),
                exit_code=result.exit_code,
                duration_ms=result.duration_ms,
                status="failed" if result.error else "completed",
            )
            ctx.db.add(execution)
            await ctx.db.flush()

            return ExecutionResult(
                output=public_output,
                error=public_error,
                exit_code=result.exit_code,
                duration_ms=result.duration_ms,
                sources=result.sources,
                execution_id=execution.id,
                sub_agent_execution_ids=result.sub_agent_execution_ids,
            )

        except Exception as e:
            duration_ms = int((time.monotonic() - start) * 1000)
            raw_error = str(e)
            error = secret_redaction_service.redact_serialized_text(raw_error, inventory)
            logger.error(f'[ToolExecutor] Tool "{tool_name}" threw: {error}')

            execution_id: str | None = None
            try:
                execution = ToolExecution(
                    capability_slug=capability_slug,
                    tool_name=tool_name,
                    input=public_input,
                    error=strip_null_bytes(error) if error else None,
                    duration_ms=duration_ms,
                    status="failed",
                )
                ctx.db.add(execution)
                await ctx.db.flush()
                execution_id = execution.id
            except Exception:
                logger.error(
                    f"[ToolExecutor] Failed to record execution error for {tool_name}"
                )

            return ExecutionResult(
                output="",
                error=error,
                duration_ms=duration_ms,
                execution_id=execution_id,
            )

    def needs_sandbox(self, tool_names: list[str]) -> bool:
        """Check if any tool in the list requires a sandbox."""
        return any(name not in _NON_SANDBOX_TOOLS for name in tool_names)


tool_executor_service = ToolExecutorService()
