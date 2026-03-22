"""Capability type definitions.

Replaces: apps/api/src/capabilities/types.ts
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class ToolDefinition(BaseModel):
    """A tool that a capability provides."""

    name: str
    description: str
    prefix: str | None = None
    script: str | None = None
    parameters: dict[str, Any] = Field(default_factory=lambda: {"type": "object", "properties": {}})


class ConfigFieldOption(BaseModel):
    label: str
    value: str


class ConfigFieldDefinition(BaseModel):
    """A configuration field for a capability."""

    key: str
    label: str
    type: Literal["string", "password", "select", "textarea"]
    required: bool
    description: str | None = None
    env_var: str = Field(alias="envVar")
    default: str | None = None
    options: list[ConfigFieldOption] | None = None
    placeholder: str | None = None

    model_config = {"populate_by_name": True}


class SandboxConfig(BaseModel):
    """Sandbox/Docker configuration for a capability."""

    docker_image: str | None = Field(default=None, alias="dockerImage")
    dockerfile: str | None = None
    packages: list[str] = Field(default_factory=list)
    network_access: bool = Field(default=False, alias="networkAccess")

    model_config = {"populate_by_name": True}


SkillType = Literal["bash", "python", "js"]
InputType = Literal["var", "secret", "textarea"]


class InputDefinition(BaseModel):
    """Full input definition for a skill."""

    type: InputType
    default: str | None = None
    description: str | None = None
    placeholder: str | None = None


class CapabilityDefinition(BaseModel):
    """A complete capability definition (builtin or skill)."""

    slug: str
    name: str
    description: str
    icon: str | None = None
    category: str
    version: str = "1.0.0"
    tools: list[ToolDefinition]
    system_prompt: str = Field(alias="systemPrompt")
    config_schema: list[ConfigFieldDefinition] | None = Field(default=None, alias="configSchema")
    installation_script: str | None = Field(default=None, alias="installationScript")
    auth_type: Literal["oauth-google"] | None = Field(default=None, alias="authType")
    skill_type: SkillType | None = Field(default=None, alias="skillType")
    sandbox: SandboxConfig = Field(default_factory=SandboxConfig)

    model_config = {"populate_by_name": True}


class SkillDefinition(BaseModel):
    """A user-defined skill plugin."""

    name: str
    slug: str
    description: str
    version: str
    icon: str | None = None
    category: str | None = None
    type: SkillType
    network_access: bool = Field(default=False, alias="networkAccess")
    instructions: str
    installation: str | None = None
    tools: list[ToolDefinition]
    inputs: dict[str, Any] | None = None

    model_config = {"populate_by_name": True}
