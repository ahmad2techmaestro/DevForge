"""Text embedders for semantic code search.

* ``HashEmbedder``: offline, deterministic feature hashing over code tokens (works with no keys).
* ``OpenAICompatEmbedder``: any ``POST {base}/embeddings`` endpoint (OpenAI, Gemini's OpenAI
  compatibility layer, Ollama, vLLM, ...). The API key is only ever sent as a bearer header and is
  scrubbed from error messages.
* ``build_embedder(settings)`` picks one from config. Runtime fallback to the hash embedder is
  handled by the caller (see ``app.repo.semantic``) so results can report which embedder was used.
"""

from __future__ import annotations

import asyncio
import math
import zlib
from collections import Counter
from collections.abc import Sequence
from typing import Any, Protocol, runtime_checkable

import httpx

from app.repo.search import tokenize

HASH_DIM = 512
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai/"
OPENAI_BASE = "https://api.openai.com/v1"
OLLAMA_BASE = "http://localhost:11434/v1"
MAX_INPUT_CHARS = 8000


class EmbeddingError(RuntimeError):
    """A remote embedding call failed (after retries)."""


@runtime_checkable
class Embedder(Protocol):
    name: str

    async def embed(self, texts: Sequence[str]) -> list[list[float]]: ...


def _bucket(feature: str, dim: int) -> tuple[int, float]:
    h = zlib.crc32(feature.encode("utf-8"))
    return h % dim, 1.0 if (h >> 20) & 1 else -1.0


class HashEmbedder:
    """Deterministic feature-hashing embedder: identifier-split tokens, bigrams and char n-grams."""

    def __init__(self, dim: int = HASH_DIM) -> None:
        self.dim = dim
        self.name = f"hash-{dim}"

    def embed_one(self, text: str) -> list[float]:
        tokens = tokenize(text[:MAX_INPUT_CHARS])
        feats: Counter[str] = Counter()
        for t in tokens:
            feats["w:" + t] += 1
            if len(t) >= 4:
                padded = f"<{t}>"
                for n in (3, 4, 5):
                    for i in range(len(padded) - n + 1):
                        feats[f"c{n}:" + padded[i : i + n]] += 0.25
        for a, b in zip(tokens, tokens[1:], strict=False):
            feats[f"b:{a}_{b}"] += 0.5
        vec = [0.0] * self.dim
        for f, count in feats.items():
            idx, sign = _bucket(f, self.dim)
            vec[idx] += sign * (1.0 + math.log(count)) if count >= 1 else sign * count
        norm = math.sqrt(sum(v * v for v in vec))
        return [v / norm for v in vec] if norm else vec

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [self.embed_one(t) for t in texts]


class OpenAICompatEmbedder:
    def __init__(
        self,
        base_url: str,
        model: str,
        api_key: str | None = None,
        *,
        label: str = "openai-compat",
        batch_size: int = 64,
        retries: int = 3,
        timeout: float = 30.0,
        backoff: float = 0.5,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self._key = api_key
        self.name = f"{label}:{model}"
        self.batch_size = max(1, batch_size)
        self.retries = max(1, retries)
        self.timeout = timeout
        self.backoff = backoff
        self._transport = transport

    def _scrub(self, text: str) -> str:
        return text.replace(self._key, "***") if self._key else text

    async def _post(self, client: httpx.AsyncClient, batch: list[str]) -> list[list[float]]:
        headers = {"Content-Type": "application/json"}
        if self._key:
            headers["Authorization"] = f"Bearer {self._key}"
        last = "unknown error"
        for attempt in range(self.retries):
            try:
                r = await client.post(
                    f"{self.base_url}/embeddings", headers=headers,
                    json={"model": self.model, "input": batch},
                )  # fmt: skip
                if r.status_code == 200:
                    return self._parse(r.json(), len(batch))
                last = f"HTTP {r.status_code}: {self._scrub(r.text[:200])}"
                if r.status_code not in (408, 409, 425, 429) and r.status_code < 500:
                    break  # non-retryable (bad key, bad model, ...)
            except (httpx.HTTPError, ValueError, KeyError, TypeError) as e:
                last = self._scrub(f"{type(e).__name__}: {e}")[:200]
            if attempt + 1 < self.retries:
                await asyncio.sleep(self.backoff * (2**attempt))
        raise EmbeddingError(f"embedding request failed: {last}")

    @staticmethod
    def _parse(data: Any, expected: int) -> list[list[float]]:
        items = sorted(data["data"], key=lambda d: d.get("index", 0))
        vecs = [[float(x) for x in d["embedding"]] for d in items]
        if len(vecs) != expected:
            raise ValueError(f"expected {expected} embeddings, got {len(vecs)}")
        return vecs

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        clipped = [t[:MAX_INPUT_CHARS] or " " for t in texts]
        out: list[list[float]] = []
        async with httpx.AsyncClient(timeout=self.timeout, transport=self._transport) as client:
            for i in range(0, len(clipped), self.batch_size):
                out += await self._post(client, clipped[i : i + self.batch_size])
        return out


def build_embedder(settings: Any) -> Embedder:
    """Create the configured embedder; never raises, defaults to the offline hash embedder."""
    provider = getattr(settings, "embedding_provider", "auto") or "auto"
    model = getattr(settings, "embedding_model", None)
    base = getattr(settings, "embedding_base_url", None)
    key = getattr(settings, "embedding_api_key", None)
    gemini_key = getattr(settings, "gemini_api_key", None)
    openai_key = getattr(settings, "openai_api_key", None)
    if provider == "auto":
        if base and model:
            provider = "openai_compatible"
        elif gemini_key:
            provider = "gemini"
        elif openai_key:
            provider = "openai"
        else:
            provider = "hash"
    if provider == "gemini" and (key or gemini_key):
        return OpenAICompatEmbedder(
            base or GEMINI_BASE, model or "gemini-embedding-001", key or gemini_key, label="gemini"
        )
    if provider == "openai" and (key or openai_key):
        obase = base or getattr(settings, "openai_base_url", None) or OPENAI_BASE
        return OpenAICompatEmbedder(obase, model or "text-embedding-3-small", key or openai_key, label="openai")
    if provider == "ollama":
        return OpenAICompatEmbedder(base or OLLAMA_BASE, model or "nomic-embed-text", key, label="ollama")
    if provider == "openai_compatible" and base and model:
        return OpenAICompatEmbedder(base, model, key or openai_key, label="compat")
    return HashEmbedder()
