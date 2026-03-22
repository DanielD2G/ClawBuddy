"""Secret redaction service — redacts secrets from tool output, SSE events, DB records.

Replaces: apps/api/src/services/secret-redaction.service.ts
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable

from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from clawbuddy.db.models import AppSettings, Workspace, WorkspaceCapability
from clawbuddy.services.config_validation import decrypt_config_fields
from clawbuddy.services.crypto import decrypt
from clawbuddy.settings import settings as env

SECRET_REDACTION_MASK = "********"

# Global env vars that may contain secrets
_GLOBAL_SECRET_ENV_SOURCES: list[tuple[str, str | None]] = [
    ("OPENAI_API_KEY", env.OPENAI_API_KEY),
    ("GEMINI_API_KEY", env.GEMINI_API_KEY),
    ("ANTHROPIC_API_KEY", env.ANTHROPIC_API_KEY),
    ("GOOGLE_CLIENT_SECRET", env.GOOGLE_CLIENT_SECRET),
    ("BROWSER_GRID_API_KEY", env.BROWSER_GRID_API_KEY),
    ("DATABASE_URL", env.DATABASE_URL),
    ("REDIS_URL", env.REDIS_URL),
    ("MINIO_ACCESS_KEY", env.MINIO_ACCESS_KEY),
    ("MINIO_SECRET_KEY", env.MINIO_SECRET_KEY),
    ("ENCRYPTION_SECRET", env.ENCRYPTION_SECRET),
]

# DB fields that may hold encrypted API keys
_DB_SECRET_FIELDS = (
    "openaiApiKey",
    "geminiApiKey",
    "anthropicApiKey",
    "browserGridApiKey",
)


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

@dataclass
class SecretReference:
    alias: str
    capability_slug: str | None = None
    transport: str = "env"  # "env" | "file" | "internal"


@dataclass
class SecretInventory:
    workspace_id: str | None = None
    enabled: bool = True
    secret_values: list[str] = field(default_factory=list)
    secret_pattern: re.Pattern[str] | None = None
    aliases: list[str] = field(default_factory=list)
    references: list[SecretReference] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _escape_regex(s: str) -> str:
    return re.escape(s)


def _build_secret_pattern(secrets: list[str]) -> re.Pattern[str] | None:
    escaped = [_escape_regex(s) for s in secrets if s]
    if not escaped:
        return None
    return re.compile("|".join(escaped))


def _collect_string_leaves(value: Any, output: set[str]) -> None:
    """Recursively collect all non-empty string values from a nested structure."""
    if isinstance(value, str):
        trimmed = value.strip()
        if trimmed:
            output.add(trimmed)
        return
    if isinstance(value, list):
        for item in value:
            _collect_string_leaves(item, output)
        return
    if isinstance(value, dict):
        for nested in value.values():
            _collect_string_leaves(nested, output)


def _strip_wrapping_quotes(value: str) -> str:
    trimmed = value.strip()
    if len(trimmed) >= 2 and (
        (trimmed[0] == '"' and trimmed[-1] == '"')
        or (trimmed[0] == "'" and trimmed[-1] == "'")
    ):
        return trimmed[1:-1]
    return trimmed


def extract_structured_secret_values(value: str) -> list[str]:
    """Extract secret values from a string that may contain JSON or .env format."""
    candidates: set[str] = set()
    trimmed = value.strip()
    if not trimmed:
        return []

    candidates.add(trimmed)

    # Try JSON parsing
    try:
        parsed = json.loads(trimmed)
        _collect_string_leaves(parsed, candidates)
    except (json.JSONDecodeError, TypeError):
        pass

    # Line-based parsing (.env-style)
    for raw_line in trimmed.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or line.startswith("["):
            continue
        if line.startswith("export "):
            line = line[len("export "):]
        sep_idx = line.find("=")
        if sep_idx == -1:
            continue
        rhs = _strip_wrapping_quotes(line[sep_idx + 1:])
        if rhs:
            candidates.add(rhs)

    return list(candidates)


def _collect_workspace_secret_values(
    schema: list[dict[str, Any]] | None,
    config: dict[str, Any] | None,
    secret_values: set[str],
    references: list[SecretReference],
    aliases: set[str],
    capability_slug: str,
) -> None:
    """Collect secret values from a workspace capability's config schema."""
    if not schema or not config:
        return

    decrypted = decrypt_config_fields(schema, config)

    for field_def in schema:
        env_var = field_def.get("envVar", "")
        if env_var:
            aliases.add(env_var)

        transport = "file" if env_var.startswith("_") else "env"

        field_type = field_def.get("type")
        if field_type not in ("password", "textarea"):
            continue

        references.append(
            SecretReference(
                alias=env_var,
                capability_slug=capability_slug,
                transport=transport,
            )
        )

        raw_value = decrypted.get(field_def["key"])
        if not isinstance(raw_value, str) or not raw_value.strip():
            continue

        for secret in extract_structured_secret_values(raw_value):
            secret_values.add(secret)


def _is_secret_redaction_enabled(workspace_settings: dict[str, Any] | None) -> bool:
    """Check workspace settings for secretRedaction flag (defaults to True)."""
    if workspace_settings is None:
        return True
    return workspace_settings.get("secretRedaction", True)


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------

class SecretRedactionService:
    """Builds secret inventories and redacts secrets from text/objects."""

    async def build_secret_inventory(
        self,
        db: AsyncSession,
        workspace_id: str | None = None,
    ) -> SecretInventory:
        """Build a comprehensive secret inventory for redaction."""
        # Check if redaction is enabled for the workspace
        if workspace_id:
            result = await db.execute(
                select(Workspace.settings).where(Workspace.id == workspace_id)
            )
            ws_settings = result.scalar_one_or_none()
            if not _is_secret_redaction_enabled(ws_settings):
                return SecretInventory(
                    workspace_id=workspace_id,
                    enabled=False,
                )

        secret_values: set[str] = set()
        aliases: set[str] = set()
        references: list[SecretReference] = []

        # 1. Global env secrets
        for alias, value in _GLOBAL_SECRET_ENV_SOURCES:
            aliases.add(alias)
            if value and value.strip():
                for secret in extract_structured_secret_values(value):
                    secret_values.add(secret)

        # 2. DB-stored encrypted API keys
        result = await db.execute(
            select(AppSettings).where(AppSettings.id == "singleton")
        )
        app_settings = result.scalar_one_or_none()
        if app_settings:
            for field_name in _DB_SECRET_FIELDS:
                encrypted = getattr(app_settings, field_name, None)
                if not encrypted:
                    continue
                try:
                    for secret in extract_structured_secret_values(decrypt(encrypted)):
                        secret_values.add(secret)
                except Exception:
                    pass

        # 3. Workspace capability config secrets
        if workspace_id:
            wc_result = await db.execute(
                select(WorkspaceCapability)
                .options(selectinload(WorkspaceCapability.capability))
                .where(
                    WorkspaceCapability.workspace_id == workspace_id,
                    WorkspaceCapability.enabled == True,
                )
            )
            workspace_caps = wc_result.scalars().all()

            for wc in workspace_caps:
                cap = wc.capability
                _collect_workspace_secret_values(
                    schema=cap.config_schema,
                    config=wc.config,
                    secret_values=secret_values,
                    references=references,
                    aliases=aliases,
                    capability_slug=cap.slug,
                )

        # Sort longest-first for greedy matching
        unique_secrets = sorted(
            [s for s in secret_values if s],
            key=len,
            reverse=True,
        )

        return SecretInventory(
            workspace_id=workspace_id,
            enabled=True,
            secret_values=unique_secrets,
            secret_pattern=_build_secret_pattern(unique_secrets),
            aliases=sorted(a for a in aliases if a),
            references=references,
        )

    def redact_text(self, text: str, inventory: SecretInventory) -> str:
        """Redact all secret values from a plain text string."""
        if not inventory.enabled:
            return text
        if not text or not inventory.secret_pattern:
            return text
        return inventory.secret_pattern.sub(SECRET_REDACTION_MASK, text)

    def redact_object(
        self,
        value: Any,
        inventory: SecretInventory,
        *,
        skip_keys: set[str] | None = None,
    ) -> Any:
        """Recursively redact secrets from a JSON-like object."""
        if not inventory.enabled:
            return value

        _skip = skip_keys or set()

        def _redact(input_val: Any) -> Any:
            if isinstance(input_val, str):
                return self.redact_text(input_val, inventory)
            if isinstance(input_val, list):
                return [_redact(item) for item in input_val]
            if isinstance(input_val, dict):
                return {
                    k: (v if k in _skip else _redact(v))
                    for k, v in input_val.items()
                }
            return input_val

        return _redact(value)

    def redact_serialized_text(
        self,
        text: str,
        inventory: SecretInventory,
        *,
        skip_keys: set[str] | None = None,
    ) -> str:
        """Redact secrets from a string that may be JSON."""
        if not inventory.enabled:
            return text
        if not text:
            return text

        try:
            parsed = json.loads(text)
            if isinstance(parsed, (dict, list)):
                return json.dumps(
                    self.redact_object(parsed, inventory, skip_keys=skip_keys)
                )
        except (json.JSONDecodeError, TypeError):
            pass

        return self.redact_text(text, inventory)

    def redact_for_public_storage(
        self,
        value: Any,
        inventory: SecretInventory,
    ) -> Any:
        """Redact secrets but preserve screenshot data."""
        return self.redact_object(value, inventory, skip_keys={"screenshot"})

    def create_redacted_emit(
        self,
        emit: Callable[..., Any],
        inventory: SecretInventory,
    ) -> Callable[..., Any]:
        """Wrap an SSE emit function to auto-redact all emitted data."""
        if not inventory.enabled:
            return emit

        async def redacted_emit(event: str, data: dict[str, Any]) -> None:
            redacted = self.redact_for_public_storage(data, inventory)
            await emit(event, redacted)

        return redacted_emit


secret_redaction_service = SecretRedactionService()
