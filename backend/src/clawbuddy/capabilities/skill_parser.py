"""Skill file parser — parses .skill JSON files into capability definitions.

Replaces: apps/api/src/capabilities/skill-parser.ts
"""

from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, Field, field_validator

from clawbuddy.capabilities.types import InputType, SkillType


# ---------------------------------------------------------------------------
# Validation schemas (replacing Zod)
# ---------------------------------------------------------------------------

class _ToolParams(BaseModel):
    type: str = "object"
    properties: dict[str, Any] = Field(default_factory=dict)
    required: list[str] | None = None


class _ToolDef(BaseModel):
    name: str
    description: str
    prefix: str | None = None
    script: str | None = None
    parameters: _ToolParams


class _InputObject(BaseModel):
    type: InputType
    default: str | None = None
    description: str | None = None
    placeholder: str | None = None


class _SkillSchema(BaseModel):
    name: str
    slug: str
    description: str
    version: str = "1.0.0"
    icon: str | None = None
    category: str = "general"
    type: SkillType
    network_access: bool = Field(default=False, alias="networkAccess")
    instructions: str
    installation: str | None = None
    tools: list[_ToolDef] = Field(min_length=1)
    inputs: dict[str, Any] | None = None

    model_config = {"populate_by_name": True}

    @field_validator("slug")
    @classmethod
    def _validate_slug(cls, v: str) -> str:
        if not re.fullmatch(r"[a-z0-9-]+", v):
            raise ValueError("Slug must be lowercase alphanumeric with hyphens")
        return v


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _humanize_key(key: str) -> str:
    """Convert snake_case or camelCase key to a human-readable label.

    e.g. "aws_access_key_id" -> "Aws Access Key Id"
    """
    # Replace underscores with spaces
    result = key.replace("_", " ")
    # Insert space before uppercase letters in camelCase
    result = re.sub(r"([a-z])([A-Z])", r"\1 \2", result)
    # Capitalize each word
    return result.title()


def _inputs_to_config_schema(
    inputs: dict[str, Any],
) -> list[dict[str, Any]]:
    """Convert skill inputs to ConfigFieldDefinition dicts.

    Supports both short form ("var" / "secret" / "textarea") and object form
    ({ type, default, description, placeholder }).
    """
    result: list[dict[str, Any]] = []
    for key, raw_input in inputs.items():
        if isinstance(raw_input, str):
            input_type: str = raw_input
            default = None
            description = None
            placeholder = None
        elif isinstance(raw_input, dict):
            parsed = _InputObject.model_validate(raw_input)
            input_type = parsed.type
            default = parsed.default
            description = parsed.description
            placeholder = parsed.placeholder
        else:
            raise ValueError(f"Invalid input definition for key '{key}'")

        # Map input types to config field types
        if input_type == "secret":
            field_type = "password"
        elif input_type == "textarea":
            field_type = "textarea"
        else:
            field_type = "string"

        field: dict[str, Any] = {
            "key": key,
            "label": _humanize_key(key),
            "type": field_type,
            "required": False,
            "envVar": key.upper(),
        }
        if default is not None:
            field["default"] = default
        if description is not None:
            field["description"] = description
        if placeholder is not None:
            field["placeholder"] = placeholder

        result.append(field)
    return result


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

class ParsedSkill:
    """Result of parsing a .skill file."""

    __slots__ = ("skill", "capability", "db_data")

    def __init__(
        self,
        skill: _SkillSchema,
        capability: dict[str, Any],
        db_data: dict[str, Any],
    ) -> None:
        self.skill = skill
        self.capability = capability
        self.db_data = db_data


def parse_skill_file(raw: Any) -> ParsedSkill:
    """Parse and validate a .skill file JSON into a capability definition.

    Returns a ParsedSkill with:
    - skill: validated SkillDefinition
    - capability: CapabilityDefinition dict
    - db_data: dict suitable for upserting into the Capability DB model
    """
    skill = _SkillSchema.model_validate(raw)

    config_schema = (
        _inputs_to_config_schema(skill.inputs) if skill.inputs else None
    )

    # Build tool definitions as plain dicts
    tools = [
        {
            "name": t.name,
            "description": t.description,
            **({"prefix": t.prefix} if t.prefix else {}),
            **({"script": t.script} if t.script else {}),
            "parameters": t.parameters.model_dump(),
        }
        for t in skill.tools
    ]

    capability: dict[str, Any] = {
        "slug": skill.slug,
        "name": skill.name,
        "description": skill.description,
        "icon": skill.icon,
        "category": skill.category,
        "version": skill.version,
        "tools": tools,
        "systemPrompt": skill.instructions,
        "sandbox": {
            "networkAccess": skill.network_access,
        },
    }
    if config_schema:
        capability["configSchema"] = config_schema

    db_data: dict[str, Any] = {
        "slug": skill.slug,
        "name": skill.name,
        "description": skill.description,
        "icon": skill.icon,
        "category": skill.category,
        "version": skill.version,
        "tool_definitions": tools,
        "system_prompt": skill.instructions,
        "docker_image": None,
        "packages": [],
        "network_access": skill.network_access,
        "config_schema": config_schema,
        "builtin": False,
        "skill_type": skill.type,
        "installation_script": skill.installation,
        "source": "skill",
    }

    return ParsedSkill(skill=skill, capability=capability, db_data=db_data)
