"""BM25 chunk search (no external vector DB)."""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass

CHUNK_LINES = 40
CHUNK_STRIDE = 30
_WORD = re.compile(r"[A-Za-z0-9]+")
_CAMEL = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+")
_STOP = frozenset(
    "the a an and or of to in is it for on with as at by be this that from are was how what "
    "does do where which".split()
)


def tokenize(text: str) -> list[str]:
    out: list[str] = []
    for word in _WORD.findall(text):
        parts = [p.lower() for p in _CAMEL.findall(word)]
        if len(parts) > 1:
            out.append(word.lower())
        out.extend(parts)
    return [t for t in out if len(t) > 1 and t not in _STOP]


@dataclass(frozen=True, slots=True)
class SearchHit:
    path: str
    line: int
    snippet: str
    score: float


@dataclass(frozen=True, slots=True)
class _Chunk:
    path: str
    start: int  # 1-based line of first line
    lines: tuple[str, ...]


class BM25Index:
    K1 = 1.5
    B = 0.75

    def __init__(self, texts: dict[str, str]) -> None:
        self._chunks: list[_Chunk] = []
        self._tf: list[Counter[str]] = []
        self._len: list[int] = []
        self._postings: dict[str, list[int]] = defaultdict(list)
        for path, text in texts.items():
            lines = text.splitlines()
            start = 0
            while start < max(len(lines), 1):
                window = tuple(lines[start : start + CHUNK_LINES])
                self._add(_Chunk(path, start + 1, window))
                if start + CHUNK_LINES >= len(lines):
                    break
                start += CHUNK_STRIDE
        n = max(len(self._len), 1)
        self._avg = sum(self._len) / n if self._len else 1.0

    def _add(self, chunk: _Chunk) -> None:
        tokens = tokenize(chunk.path) + tokenize("\n".join(chunk.lines))
        tf = Counter(tokens)
        idx = len(self._chunks)
        self._chunks.append(chunk)
        self._tf.append(tf)
        self._len.append(len(tokens))
        for term in tf:
            self._postings[term].append(idx)

    def search(self, query: str, limit: int = 20, per_file: int = 2) -> list[SearchHit]:
        terms = list(dict.fromkeys(tokenize(query)))
        n = len(self._chunks)
        scores: dict[int, float] = defaultdict(float)
        for term in terms:
            posting = self._postings.get(term)
            if not posting:
                continue
            idf = math.log(1 + (n - len(posting) + 0.5) / (len(posting) + 0.5))
            for idx in posting:
                tf = self._tf[idx][term]
                norm = tf + self.K1 * (1 - self.B + self.B * self._len[idx] / self._avg)
                scores[idx] += idf * tf * (self.K1 + 1) / norm
        hits: list[SearchHit] = []
        seen: Counter[str] = Counter()
        for idx, score in sorted(scores.items(), key=lambda kv: (-kv[1], kv[0])):
            chunk = self._chunks[idx]
            if seen[chunk.path] >= per_file:
                continue
            seen[chunk.path] += 1
            hits.append(self._hit(chunk, terms, score))
            if len(hits) >= limit:
                break
        return hits

    @staticmethod
    def _hit(chunk: _Chunk, terms: list[str], score: float) -> SearchHit:
        term_set = set(terms)
        best, best_n = 0, -1
        for i, line in enumerate(chunk.lines):
            n = sum(1 for t in tokenize(line) if t in term_set)
            if n > best_n:
                best, best_n = i, n
        lo, hi = max(0, best - 2), min(len(chunk.lines), best + 3)
        snippet = "\n".join(chunk.lines[lo:hi])
        return SearchHit(chunk.path, chunk.start + best, snippet[:400], round(score, 4))
