"""Document Search capability.

Replaces: apps/api/src/capabilities/builtin/document-search.ts
"""

from __future__ import annotations

from typing import Any

DOCUMENT_SEARCH: dict[str, Any] = {
    "slug": "document-search",
    "name": "Document Search",
    "description": (
        "Search through uploaded documents using semantic similarity. "
        "This is the core RAG capability."
    ),
    "icon": "FileSearch",
    "category": "builtin",
    "version": "1.0.0",
    "tools": [
        {
            "name": "search_documents",
            "description": (
                "Search through the workspace documents using semantic similarity. "
                "Returns relevant text chunks from uploaded documents."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query to find relevant document chunks",
                    },
                    "documentIds": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional list of specific document IDs to search within",
                    },
                },
                "required": ["query"],
            },
        },
    ],
    "systemPrompt": (
        "You have access to search_documents to search the workspace knowledge base. "
        "Use it when the user asks about uploaded documents, references a document by "
        "name or title, or asks questions that might be answered by the workspace's "
        "indexed content. The knowledge base contains documents that were uploaded by "
        "the user — it is NOT the sandbox filesystem. Do NOT use it for files generated "
        "during this conversation, greetings, general conversation, or when the user is "
        "clearly asking you to use another tool.\n\n"
        "When search_documents returns results, use them directly to answer the user's "
        'question. Always cite the source document name (e.g. "According to '
        'README.md..."). Do NOT use bash to re-read or post-process search results. '
        "If results are not relevant, answer from your own knowledge."
    ),
    "sandbox": {},
}
