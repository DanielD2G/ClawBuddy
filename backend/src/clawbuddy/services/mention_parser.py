"""Mention parser service — extracts /mentions from chat messages.

Replaces: apps/api/src/services/mention-parser.service.ts
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


# Matches /slug-name patterns at word boundaries
_MENTION_REGEX = re.compile(r"(?:^|\s)/([a-z0-9-]+)")


@dataclass
class ParseResult:
    cleaned_content: str
    mentioned_slugs: list[str] = field(default_factory=list)


class MentionParserService:
    """Extract /mentions from message content and return cleaned text + slugs."""

    def parse(self, content: str) -> ParseResult:
        """Extract /mentions from message content.

        Returns cleaned content (without mentions) and list of unique slugs.
        """
        mentioned_slugs: list[str] = []
        seen: set[str] = set()

        for match in _MENTION_REGEX.finditer(content):
            slug = match.group(1)
            if slug not in seen:
                mentioned_slugs.append(slug)
                seen.add(slug)

        # Remove /mentions from content for cleaner LLM input
        cleaned = _MENTION_REGEX.sub("", content)
        # Collapse multiple spaces
        cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()

        return ParseResult(
            cleaned_content=cleaned,
            mentioned_slugs=mentioned_slugs,
        )

    def resolve_mentions(
        self,
        mentioned_slugs: list[str],
        enabled_capabilities: list[dict[str, str]],
    ) -> list[str]:
        """Resolve mentioned slugs against available capabilities.

        Returns valid capability slugs that are actually enabled.
        """
        enabled_set = {c.get("slug") for c in enabled_capabilities}
        return [slug for slug in mentioned_slugs if slug in enabled_set]


mention_parser_service = MentionParserService()
