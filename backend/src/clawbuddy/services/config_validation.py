"""Capability config validation, encryption, masking.

Replaces: apps/api/src/services/config-validation.service.ts
"""

from __future__ import annotations

from typing import Any

from clawbuddy.services.crypto import decrypt, encrypt

_MASK = "••••••••"


def _get_secret_field_keys(schema: list[dict[str, Any]]) -> set[str]:
    """Extract keys of fields that should be encrypted (password/textarea types)."""
    return {
        f["key"]
        for f in schema
        if f.get("type") in ("password", "textarea")
    }


class _ValidationResult:
    __slots__ = ("valid", "errors")

    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        self.valid = len(errors) == 0


def validate_capability_config(
    schema: list[dict[str, Any]],
    config: dict[str, Any],
) -> _ValidationResult:
    """Validate a capability config against its schema."""
    errors: list[str] = []

    for field in schema:
        key = field["key"]
        value = config.get(key)

        if field.get("required"):
            if value is None or value == "":
                errors.append(f"{field.get('label', key)} is required")
                continue

        if value is not None and value != "":
            if field.get("type") == "select" and field.get("options"):
                valid_values = [o["value"] for o in field["options"]]
                if value not in valid_values:
                    errors.append(f"{field.get('label', key)}: invalid option \"{value}\"")

    return _ValidationResult(errors)


def encrypt_config_fields(
    schema: list[dict[str, Any]],
    config: dict[str, Any],
) -> dict[str, Any]:
    """Encrypt secret fields in a capability config."""
    result = dict(config)
    secret_keys = _get_secret_field_keys(schema)

    for key in list(result.keys()):
        if key in secret_keys and isinstance(result[key], str) and result[key]:
            result[key] = encrypt(result[key])

    return result


def decrypt_config_fields(
    schema: list[dict[str, Any]],
    config: dict[str, Any],
) -> dict[str, Any]:
    """Decrypt secret fields in a capability config."""
    result = dict(config)
    secret_keys = _get_secret_field_keys(schema)

    for key in list(result.keys()):
        if key in secret_keys and isinstance(result[key], str) and result[key]:
            try:
                result[key] = decrypt(result[key])
            except Exception:
                # Value may not be encrypted (e.g. during migration)
                pass

    return result


def mask_config_fields(
    schema: list[dict[str, Any]],
    config: dict[str, Any],
) -> dict[str, Any]:
    """Mask secret fields in a capability config for display."""
    result = dict(config)
    secret_keys = _get_secret_field_keys(schema)

    for key in list(result.keys()):
        if key in secret_keys and isinstance(result[key], str) and result[key]:
            result[key] = _MASK

    return result


def is_masked_value(value: Any) -> bool:
    """Check if a value is a masked placeholder."""
    return value == _MASK


def merge_with_existing_config(
    schema: list[dict[str, Any]],
    new_config: dict[str, Any],
    existing_config: dict[str, Any],
) -> dict[str, Any]:
    """Merge new config with existing, preserving encrypted values when masked."""
    result = dict(new_config)
    secret_keys = _get_secret_field_keys(schema)

    for key in list(result.keys()):
        if key in secret_keys and is_masked_value(result[key]):
            result[key] = existing_config.get(key)

    return result
