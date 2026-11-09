"""Second-stage reranking: re-order the top fused search hits by how well they answer the query.

Two backends, both optional (the fused order is the safe fallback, and the result says which was used):
- HttpReranker: any Cohere-compatible /rerank API (Cohere, Jina, Voyage, self-hosted TEI).
- LlmReranker: asks the chat model to order the candidates (works with any LLM key, e.g. free Gemini).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Protocol

import httpx

from app.llm.structured import RankOut

MAX_DOC_CHARS = 700


class Reranker(Protocol):
    name: str

    async def rerank(self, query: str, docs: list[str]) -> list[int]:
        """Indices into `docs`, most relevant first (may omit irrelevant ones)."""


class HttpReranker:
    def __init__(self, base_url: str, api_key: str, model: str, client: httpx.AsyncClient | None = None) -> None:
        self.url = base_url.rstrip("/") + "/rerank"
        self.api_key, self.model = api_key, model
        self.name = f"http:{model}"
        self._client = client

    async def rerank(self, query: str, docs: list[str]) -> list[int]:
        body = {"model": self.model, "query": query, "documents": [d[:MAX_DOC_CHARS] for d in docs], "top_n": len(docs)}
        async with (self._client or httpx.AsyncClient(timeout=20)) as c:
            r = await c.post(self.url, json=body, headers={"Authorization": f"Bearer {self.api_key}"})
        r.raise_for_status()
        results = r.json().get("results", [])
        return [int(x["index"]) for x in sorted(results, key=lambda x: -float(x.get("relevance_score", 0))) if 0 <= int(x["index"]) < len(docs)]


class LlmReranker:
    """`ask` runs one structured call: (query, numbered candidates) -> RankOut."""

    name = "llm"

    def __init__(self, ask: Callable[[str, str], Awaitable[RankOut | None]]) -> None:
        self.ask = ask

    async def rerank(self, query: str, docs: list[str]) -> list[int]:
        listing = "\n\n".join(f"[{i}] {d[:MAX_DOC_CHARS]}" for i, d in enumerate(docs))
        out = await self.ask(query, listing)
        if out is None:
            raise ValueError("model returned no ranking")
        seen: list[int] = []
        for i in out.ranking:
            if 0 <= i < len(docs) and i not in seen:
                seen.append(i)
        return seen


async def apply_rerank(
    reranker: Reranker | None, query: str, results: list[dict[str, Any]], limit: int,
) -> tuple[list[dict[str, Any]], str | None]:
    """Reorder `results`; on any failure keep the fused order. Returns (results[:limit], backend used or None)."""
    if reranker is None or len(results) < 2:
        return results[:limit], None
    try:
        order = await reranker.rerank(query, [str(r.get("snippet", "")) for r in results])
    except Exception:
        return results[:limit], None
    if not order:
        return results[:limit], None
    rest = [i for i in range(len(results)) if i not in order]  # candidates the reranker dropped keep their relative order, last
    return [results[i] for i in [*order, *rest]][:limit], reranker.name
