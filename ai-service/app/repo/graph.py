"""Import graph for Python / JS / TS."""

from __future__ import annotations

import posixpath
import re

from app.repo.files import FileInfo

_PY_IMPORT = re.compile(r"^\s*(?:from\s+([.\w]+)\s+import\s+([\w*, ()]+)|import\s+([\w., ]+))", re.M)
_JS_IMPORT = re.compile(
    r"""(?:import\s+(?:[^'"]*?\sfrom\s+)?|export\s+[^'"]*?\sfrom\s+|require\(\s*|import\(\s*)['"]([^'"]+)['"]"""
)
_JS_EXTS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")
MAX_NODES = 400


def _py_module_index(paths: set[str]) -> dict[str, str]:
    mods: dict[str, str] = {}
    for p in paths:
        if not p.endswith(".py"):
            continue
        mod = p[:-3].replace("/", ".")
        if mod.endswith(".__init__"):
            mod = mod[: -len(".__init__")]
        mods[mod] = p
        # also allow imports relative to a source root (src/pkg/x.py -> pkg.x)
        parts = mod.split(".")
        for i in range(1, len(parts)):
            mods.setdefault(".".join(parts[i:]), p)
    return mods


def _resolve_py(src: str, text: str, mods: dict[str, str]) -> set[str]:
    out: set[str] = set()
    pkg = posixpath.dirname(src).replace("/", ".")
    for m in _PY_IMPORT.finditer(text):
        if m.group(1):
            base, names = m.group(1), [n.strip() for n in m.group(2).strip("() ").split(",")]
            if base.startswith("."):
                dots = len(base) - len(base.lstrip("."))
                parent = pkg.split(".") if pkg else []
                parent = parent[: len(parent) - (dots - 1)] if dots > 1 else parent
                base = ".".join([*parent, base.lstrip(".")]).strip(".")
            candidates = [f"{base}.{n.split(' as ')[0]}" if base else n for n in names] + [base]
        else:
            candidates = [n.strip().split(" as ")[0] for n in m.group(3).split(",")]
        for c in candidates:
            if c in mods and mods[c] != src:
                out.add(mods[c])
    return out


def _resolve_js(src: str, spec: str, paths: set[str]) -> str | None:
    if not spec.startswith("."):
        return None
    base = posixpath.normpath(posixpath.join(posixpath.dirname(src), spec))
    stem = re.sub(r"\.(c|m)?jsx?$", "", base)
    options = [base, *(base + e for e in _JS_EXTS), *(stem + e for e in _JS_EXTS)]
    options += [posixpath.join(base, "index" + e) for e in _JS_EXTS]
    for o in options:
        if o in paths and o != src:
            return o
    return None


def build_graph(
    files: list[FileInfo], texts: dict[str, str]
) -> dict[str, list[dict[str, object]]]:
    paths = {f.path for f in files}
    mods = _py_module_index(paths)
    edges: set[tuple[str, str]] = set()
    for f in files:
        text = texts.get(f.path, "")
        if f.language == "Python":
            edges |= {(f.path, t) for t in _resolve_py(f.path, text, mods)}
        elif f.language in ("JavaScript", "TypeScript"):
            for m in _JS_IMPORT.finditer(text):
                target = _resolve_js(f.path, m.group(1), paths)
                if target:
                    edges.add((f.path, target))
    degree: dict[str, int] = {}
    for s, t in edges:
        degree[s] = degree.get(s, 0) + 1
        degree[t] = degree.get(t, 0) + 1
    code = [f for f in files if f.language in ("Python", "JavaScript", "TypeScript")]
    ranked = sorted(code, key=lambda f: (-degree.get(f.path, 0), f.path))[:MAX_NODES]
    keep = {f.path for f in ranked}
    return {
        "nodes": [
            {"id": f.path, "path": f.path, "language": f.language, "lines": f.lines,
             "degree": degree.get(f.path, 0)}
            for f in ranked
        ],
        "edges": [{"source": s, "target": t} for s, t in sorted(edges) if s in keep and t in keep],
    }  # fmt: skip
