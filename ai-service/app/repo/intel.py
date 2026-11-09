"""Code intelligence over a RepoIndex: symbols, call graph, dependents and impact analysis.

Engine is tree-sitter when the optional ``intel`` extra works, otherwise a stdlib/regex fallback
(see symbols.py). Every result carries ``engine`` so callers can tell which one produced it.
"""

from __future__ import annotations

import re
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from app.repo.graph import _JS_IMPORT, _py_module_index, _resolve_js, _resolve_py
from app.repo.symbols import SUPPORTED, FileSymbols, analyze_file, treesitter_available

if TYPE_CHECKING:
    from app.repo.index import RepoIndex

_TEST_RE = re.compile(r"(^|/)(tests?|__tests__|spec)(/|$)|(^|/)(test_[^/]+|[^/]+_test\.(py|go)|[^/]+\.(test|spec)\.[jt]sx?|[^/]+Test\.java)$")
_COMMON = frozenset({  # call names too generic to link across files
    "get", "set", "add", "run", "main", "init", "print", "len", "str", "int", "list", "dict", "map",
    "push", "pop", "open", "close", "read", "write", "log", "then", "catch", "join", "split",
    "keys", "values", "items", "append", "extend", "update", "format", "error", "info", "test",
    "describe", "it", "expect", "require", "super", "toString", "equals", "length", "forEach",
})  # fmt: skip


def is_test_path(path: str) -> bool:
    return bool(_TEST_RE.search(path))


@dataclass(slots=True)
class CodeIntel:
    engine: str
    files: dict[str, FileSymbols] = field(default_factory=dict)
    file_edges: dict[str, set[str]] = field(default_factory=lambda: defaultdict(set))  # src -> deps
    reverse: dict[str, set[str]] = field(default_factory=lambda: defaultdict(set))  # dep -> dependents
    defs: dict[str, list[tuple[str, str]]] = field(default_factory=lambda: defaultdict(list))
    # symbol-level: (path, qname) -> callers [(path, qname)]
    callers: dict[tuple[str, str], set[tuple[str, str]]] = field(default_factory=lambda: defaultdict(set))
    callees: dict[tuple[str, str], set[tuple[str, str]]] = field(default_factory=lambda: defaultdict(set))

    # ------------------------------------------------------------------ build
    @classmethod
    def build(cls, index: RepoIndex) -> CodeIntel:
        intel = cls("tree-sitter" if treesitter_available() else "fallback")
        paths = {f.path for f in index.files}
        for f in index.files:
            if f.language in SUPPORTED:
                fs = analyze_file(f.path, f.language, index.texts.get(f.path, ""))
                if fs is not None:
                    intel.files[f.path] = fs
                    for s in fs.symbols:
                        intel.defs[s.name].append((f.path, s.qname))
        mods = _py_module_index(paths)
        for path, fs in intel.files.items():
            text = index.texts.get(path, "")
            targets: set[str] = set()
            if fs.language == "Python":
                targets |= _resolve_py(path, text, mods)
            elif fs.language in ("JavaScript", "TypeScript"):
                for m in _JS_IMPORT.finditer(text):
                    t = _resolve_js(path, m.group(1), paths)
                    if t:
                        targets.add(t)
            for c in fs.calls:
                if c.name in _COMMON or len(c.name) < 3:
                    continue
                cands = [d for d in intel.defs.get(c.name, []) if d[0] != path]
                if c.qualifier is None and (c.name in {s.name for s in fs.symbols}):
                    cands = [(path, q) for (p, q) in intel.defs[c.name] if p == path]
                # link only unambiguous targets, or ones in files this file imports
                if len(cands) == 1 or (cands and (imported := [d for d in cands if d[0] in targets])):
                    chosen = cands if len(cands) == 1 else imported
                    for tp, tq in chosen:
                        if tp != path:
                            targets.add(tp)
                        if c.caller:
                            intel.callers[(tp, tq)].add((path, c.caller))
                            intel.callees[(path, c.caller)].add((tp, tq))
            targets.discard(path)
            for t in targets:
                intel.file_edges[path].add(t)
                intel.reverse[t].add(path)
        return intel

    # ------------------------------------------------------------------ queries
    def symbols(self, path: str | None = None) -> list[dict[str, object]]:
        files = [self.files[path]] if path and path in self.files else ([] if path else list(self.files.values()))
        return [s.to_json() for fs in files for s in fs.symbols]

    def _bfs(self, start: set[str]) -> tuple[list[str], list[str]]:
        direct = sorted(set().union(*(self.reverse.get(p, set()) for p in start)) - start) if start else []
        seen = set(start) | set(direct)
        queue = deque(direct)
        trans: list[str] = []
        while queue:
            cur = queue.popleft()
            for nxt in sorted(self.reverse.get(cur, ())):
                if nxt not in seen:
                    seen.add(nxt)
                    trans.append(nxt)
                    queue.append(nxt)
        return direct, trans

    def impact(self, path: str, symbol: str | None = None) -> dict[str, object]:
        fs = self.files.get(path)
        direct, trans = self._bfs({path})
        sym_callers: list[dict[str, object]] = []
        if symbol:
            seen: set[tuple[str, str]] = set()
            queue = deque([(path, symbol)])
            while queue:
                cur = queue.popleft()
                for c in sorted(self.callers.get(cur, ())):
                    if c not in seen:
                        seen.add(c)
                        queue.append(c)
                        sym_callers.append({"path": c[0], "symbol": c[1]})
            affected_files = {c["path"] for c in sym_callers}  # type: ignore[misc]
            direct = sorted(affected_files & set(direct)) or sorted(affected_files)
            trans = [t for t in trans if t not in direct]
        everything = [*direct, *trans]
        tests = sorted({p for p in everything if is_test_path(p)})
        if is_test_path(path):
            tests = [path]
        non_tests = [p for p in everything if not is_test_path(p)]
        n = len(non_tests)
        risk = "high" if n >= 8 else "medium" if n >= 3 else "low"
        if n and not tests:
            risk = {"low": "medium", "medium": "high"}.get(risk, risk)
        target = f"{path}::{symbol}" if symbol else path
        summary = (
            f"{target} is used by {len(direct)} file(s) directly and {len(trans)} more indirectly; "
            + (f"{len(tests)} test file(s) cover that surface." if tests else "no test file reaches it.")
        )
        return {
            "engine": self.engine, "target": target, "exists": fs is not None,
            "direct": direct, "transitive": trans, "tests": tests,
            "symbolCallers": sym_callers, "risk": risk, "summary": summary,
        }  # fmt: skip

    def callgraph(self, path: str | None = None) -> dict[str, object]:
        keep = {path} if path else set(self.files)
        nodes: dict[str, dict[str, object]] = {}
        edges: list[dict[str, str]] = []

        def node(p: str, q: str) -> str:
            nid = f"{p}::{q}"
            if nid not in nodes:
                nodes[nid] = {"id": nid, "path": p, "symbol": q}
            return nid

        for (cp, cq), targets in self.callees.items():
            for tp, tq in targets:
                if cp in keep or tp in keep:
                    edges.append({"from": node(cp, cq), "to": node(tp, tq)})
                    if len(edges) >= 600:
                        return {"engine": self.engine, "nodes": list(nodes.values()), "edges": edges, "truncated": True}
        return {"engine": self.engine, "nodes": list(nodes.values()), "edges": edges, "truncated": False}


def dependents_of(intel: CodeIntel, path: str) -> list[str]:
    d, t = intel._bfs({path})
    return [*d, *t]


__all__ = ["CodeIntel", "dependents_of", "is_test_path"]
