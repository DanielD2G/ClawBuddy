"""Text sanitization utilities.

Replaces: apps/api/src/lib/sanitize.ts
"""

from __future__ import annotations

import re

# Pre-compiled patterns
_UNSAFE_FILENAME_RE = re.compile(r"[^a-zA-Z0-9._-]")
_NULL_BYTE_RE = re.compile(r"\x00")
_ESCAPED_NULL_RE = re.compile(r"\\u0000")
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def sanitize_file_name(name: str) -> str:
    """Replace characters that are unsafe for storage keys / file paths."""
    return _UNSAFE_FILENAME_RE.sub("_", name)


def strip_null_bytes(s: str) -> str:
    """Strip null bytes and control characters that PostgreSQL TEXT columns reject.

    This is the canonical sanitizer for any text destined for DB storage.
    """
    result = _NULL_BYTE_RE.sub("", s)
    result = _ESCAPED_NULL_RE.sub("", result)
    result = _CONTROL_CHARS_RE.sub("", result)
    return result


def strip_null_bytes_or_null(text: str | None) -> str | None:
    """Nullable wrapper — returns None for falsy input, stripped string otherwise."""
    if not text:
        return None
    return strip_null_bytes(text)


def sanitize_surrogates(input_str: str) -> str:
    """Replace lone surrogates with U+FFFD to prevent JSON serialization errors.

    Handles a different concern than strip_null_bytes — use for content from
    external files that may contain malformed Unicode.

    Note: In Python 3, strings are sequences of Unicode code points, so lone
    surrogates are uncommon but can appear when reading files with
    ``errors='surrogateescape'`` or via C extensions.
    """
    # Python's str type normally can't contain lone surrogates, but
    # surrogatepass/surrogateescape can produce them. We use encode/decode
    # round-trip to detect and replace them.
    try:
        # If this succeeds, the string has no lone surrogates
        input_str.encode("utf-8")
        return input_str
    except UnicodeEncodeError:
        # Replace lone surrogates with U+FFFD
        return input_str.encode("utf-8", errors="surrogatepass").decode(
            "utf-8", errors="replace"
        )
