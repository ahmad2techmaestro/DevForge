"""Semantic + hybrid code search: BM25 and embedding cosine fused with Reciprocal Rank Fusion."""

from __future__ import annotations

import hashlib
import math
import sqlite3
from array import array
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from app.repo.embeddings import Embedder, HashEmbedder
from app.repo.symbols import FUNC_KINDS, analyze_file

if TYPE_CHECKING:
    from app.repo.index import RepoIndex

WINDOW = 40
STRIDE = 30
MAX_CHUNKS = 4000
MAX_CHUNK_CHARS = 2000
RRF_K = 60


@dataclass(frozen=True, slots=True)
class Chunk:
    path: str
    line: int
    end_line: int
    symbol: str | None
    text: str

    @property
    def key(self) -> str:
        return hashlib.sha1(f"{self.path}\0{self.text}".encode(), usedforsecurity=False).hexdigest()


def chunk_repo(index: RepoIndex) -> list[Chunk]:
    chunks: list[Chunk] = []
    for f in index.files:
        text = index.texts.get(f.path, "")
        if not text.strip():
            continue
        lines = text.splitlines()
        fs = analyze_file(f.path, f.language, text)
        spans: list[tuple[int, int, str | None]] = []
        if fs and fs.symbols:
            for s in fs.symbols:
                if s.kind in FUNC_KINDS or s.kind in ("class", "interface", "struct", "type", "enum"):
                    if s.kind == "class" and s.end_line - s.line > WINDOW:
                        continue  # large classes are covered by their methods
                    spans.append((s.line, s.end_line, s.qname))
        covered = {n for a, b, _ in spans for n in range(a, b + 1)}
        start = 1
        while start <= len(lines):  # windows for code outside any symbol (and symbol-less files)
            end = min(start + WINDOW - 1, len(lines))
            if sum(1 for n in range(start, end + 1) if n not in covered) > WINDOW // 3:
                spans.append((start, end, None))
            if end >= len(lines):
                break
            start += STRIDE
        for a, b, sym in spans:
            body = "\n".join(lines[a - 1 : b])[:MAX_CHUNK_CHARS]
            head = f"{f.path}" + (f" {sym}" if sym else "")
            chunks.append(Chunk(f.path, a, b, sym, f"{head}\n{body}"))
            if len(chunks) >= MAX_CHUNKS:
                return chunks
    return chunks


def _cosine(a: list[float], b: array) -> float:
    return sum(x * y for x, y in zip(a, b, strict=False))


class VectorStore:
    """sqlite cache of chunk vectors keyed by (embedder, chunk hash); best effort."""

    def __init__(self, path: Path | None) -> None:
        self.db: sqlite3.Connection | None = None
        if path is not None:
            try:
                self.db = sqlite3.connect(str(path))
                self.db.execute("CREATE TABLE IF NOT EXISTS v (k TEXT, e TEXT, d BLOB, PRIMARY KEY (k, e))")
            except sqlite3.Error:
                self.db = None

    def get(self, embedder: str, keys: list[str]) -> dict[str, array]:
        out: dict[str, array] = {}
        if not self.db:
            return out
        for i in range(0, len(keys), 500):
            batch = keys[i : i + 500]
            q = f"SELECT k, d FROM v WHERE e = ? AND k IN ({','.join('?' * len(batch))})"
            for k, d in self.db.execute(q, [embedder, *batch]):
                arr = array("f")
                arr.frombytes(d)
                out[k] = arr
        return out

    def put(self, embedder: str, items: dict[str, array]) -> None:
        if not self.db or not items:
            return
        try:
            self.db.executemany("INSERT OR REPLACE INTO v VALUES (?, ?, ?)", [(k, embedder, v.tobytes()) for k, v in items.items()])
            self.db.commit()
        except sqlite3.Error:
            pass


class SemanticIndex:
    def __init__(self, index: RepoIndex, embedder: Embedder, cache: Path | None = None) -> None:
        self.index = index
        self.embedder = embedder
        self.used = embedder.name
        self.store = VectorStore(cache)
        self.chunks = chunk_repo(index)
        self.vectors: dict[str, array] = {}
        self._ready = False

    async def _embed(self, embedder: Embedder, texts: list[str]) -> list[list[float]]:
        return await embedder.embed(texts)

    async def ensure(self) -> None:
        if self._ready:
            return
        keys = [c.key for c in self.chunks]
        have = self.store.get(self.embedder.name, keys)
        todo = [c for c in self.chunks if c.key not in have]
        embedder = self.embedder
        if todo:
            try:
                vecs = await self._embed(embedder, [c.text for c in todo])
            except Exception:  # remote embedder down: fall back to offline vectors for this index
                embedder = HashEmbedder()
                self.used = embedder.name
                have = self.store.get(embedder.name, keys)
                todo = [c for c in self.chunks if c.key not in have]
                vecs = await self._embed(embedder, [c.text for c in todo])
            fresh = {c.key: array("f", v) for c, v in zip(todo, vecs, strict=True)}
            self.store.put(embedder.name, fresh)
            have.update(fresh)
        self.embedder, self.vectors, self._ready = embedder, have, True

    async def semantic(self, query: str, limit: int) -> list[tuple[Chunk, float]]:
        await self.ensure()
        qv = (await self._embed(self.embedder, [query]))[0]
        scored = [(c, _cosine(qv, self.vectors[c.key])) for c in self.chunks if c.key in self.vectors]
        scored.sort(key=lambda x: -x[1])
        return [(c, s) for c, s in scored[:limit] if s > 0 and math.isfinite(s)]

    async def search(self, query: str, mode: str = "hybrid", limit: int = 10) -> dict[str, object]:
        bm = self.index.bm25.search(query, limit * 3)
        sem: list[tuple[Chunk, float]] = []
        if mode in ("semantic", "hybrid"):
            sem = await self.semantic(query, limit * 3)
        if mode == "bm25":
            ranked = [(h.path, h.line, None, h.snippet, h.score, None) for h in bm[:limit]]
        elif mode == "semantic":
            ranked = [(c.path, c.line, c.end_line, c.text.split("\n", 1)[-1][:400], s, c.symbol) for c, s in sem[:limit]]
        else:
            fused: dict[tuple[str, int], float] = {}
            info: dict[tuple[str, int], tuple[str, int, int | None, str, float, str | None]] = {}
            for rank, (c, s) in enumerate(sem):
                k = (c.path, c.line)
                fused[k] = fused.get(k, 0.0) + 1 / (RRF_K + rank + 1)
                info[k] = (c.path, c.line, c.end_line, c.text.split("\n", 1)[-1][:400], s, c.symbol)
            for rank, h in enumerate(bm):
                # attach BM25 hits to the semantic chunk that contains the line, if any
                k = next(((c.path, c.line) for c in self.chunks if c.path == h.path and c.line <= h.line <= c.end_line), (h.path, h.line))
                fused[k] = fused.get(k, 0.0) + 1 / (RRF_K + rank + 1)
                info.setdefault(k, (h.path, h.line, None, h.snippet, h.score, None))
            top = sorted(fused, key=lambda k: -fused[k])[:limit]
            ranked = [(*info[k][:4], round(fused[k], 5), info[k][5]) for k in top]
        return {
            "mode": mode,
            "embedder": self.used,
            "results": [
                {"path": p, "line": ln, "endLine": el, "snippet": sn, "score": round(float(sc), 5), "symbol": sy}
                for p, ln, el, sn, sc, sy in ranked
            ],
        }
