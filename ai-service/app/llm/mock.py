"""Deterministic offline provider: grounded template answers + real generated smoke tests."""

from __future__ import annotations

import ast
import asyncio
import re

from app.llm.base import ChatResult, PlanResult, ReviewResult, WorkContext
from app.llm.static_review import NOTE_PATH, static_comments
from app.llm.tools import WorkspaceTools
from app.llm.usage import UsageMeter
from app.repo.files import is_test_path
from app.repo.index import RepoIndex
from app.repo.risk import added_lines
from app.repo.rules import analyze_file
from app.schemas import ChatMessage, Finding, PlanStep
from app.types import Emit

_SKIP_NAMES = {"__init__.py", "__main__.py", "conftest.py", "setup.py", "manage.py"}
_JS_EXT = (".js", ".mjs", ".cjs")


def _tok(text: str) -> int:
    return max(len(text) // 4, 1)


def _slug(path: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", path.rsplit(".", 1)[0]).strip("_").lower()


def _py_public_functions(text: str) -> list[str]:
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []
    return [
        n.name for n in tree.body
        if isinstance(n, ast.FunctionDef | ast.AsyncFunctionDef) and not n.name.startswith("_")
    ][:10]  # fmt: skip


def _is_python_candidate(path: str, text: str) -> bool:
    name = path.rsplit("/", 1)[-1]
    if not path.endswith(".py") or name in _SKIP_NAMES or is_test_path(path):
        return False
    try:
        ast.parse(text)
    except SyntaxError:
        return False
    return bool(text.strip())


def _is_js_candidate(path: str, text: str) -> bool:
    if not path.endswith(_JS_EXT) or is_test_path(path) or ".config." in path:
        return False
    return not re.search(r"\.listen\(|process\.exit|^#!", text, re.M) and bool(text.strip())


def pick_targets(index: RepoIndex, preferred: list[str], limit: int = 3) -> list[str]:
    """Up to `limit` modules worth smoke-testing; one language only (Python wins)."""
    ordered = [p for p in preferred if p in index.texts] + sorted(index.texts)
    for check in (_is_python_candidate, _is_js_candidate):
        picked = [p for p in dict.fromkeys(ordered) if check(p, index.texts[p])]
        if picked:
            return picked[:limit]
    return []


def python_smoke_test(path: str, public: list[str]) -> str:
    dotted = path[:-3].replace("/", ".")
    importable = all(part.isidentifier() for part in dotted.split("."))
    names = ", ".join(repr(n) for n in public)
    return f'''"""DevForge-generated smoke tests for `{path}`. Review before merging."""

import importlib
import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "{path}"
PUBLIC_FUNCTIONS = [{names}]


def _load():
    for extra in (ROOT, ROOT / "src", MODULE_PATH.parent):
        if str(extra) not in sys.path:
            sys.path.insert(0, str(extra))
    try:
        if {importable!r}:
            try:
                return importlib.import_module("{dotted}")
            except ImportError:
                pass
        spec = importlib.util.spec_from_file_location("devforge_smoke_{_slug(path)}", MODULE_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except ImportError as exc:  # missing third-party dependency in this environment
        pytest.skip(f"cannot import {path}: {{exc}}")


def test_module_imports():
    assert _load() is not None


@pytest.mark.parametrize("name", PUBLIC_FUNCTIONS)
def test_public_function_is_callable(name):
    assert callable(getattr(_load(), name))
'''


def js_smoke_test(path: str, text: str) -> str:
    funcs = re.findall(r"^export\s+(?:async\s+)?function\s+(\w+)", text, re.M)[:10]
    checks = "\n".join(
        f"  assert.equal(typeof mod.{n}, 'function', '{n} should be exported');" for n in funcs
    )
    return f"""// DevForge-generated smoke test for `{path}`. Review before merging.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {{ fileURLToPath, pathToFileURL }} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('{path} can be loaded', async () => {{
  const mod = await import(pathToFileURL(path.join(root, '{path}')).href);
  assert.ok(mod !== null && typeof mod === 'object');
{checks}
}});
"""


def _ref(hit_path: str, line: int) -> str:
    return f"`{hit_path}:{line}`"


MEMORY_HEADER = "\n\n## Repository memory"


def task_text(brief: str) -> str:
    """The user's own task text without the appended repository-memory block."""
    return brief.split(MEMORY_HEADER, 1)[0]


class MockBrain:
    provider = "mock"

    def __init__(self, meter: UsageMeter) -> None:
        self.meter = meter

    def _count(self, prompt: str, answer: str) -> None:
        self.meter.add(_tok(prompt), _tok(answer))

    async def plan(
        self, index: RepoIndex, kind: str, title: str, description: str, feedback: str | None,
        emit: Emit,
    ) -> PlanResult:
        description = task_text(description)
        query = f"{title} {description}"
        hits = index.bm25.search(query, limit=8)
        relevant = [h.path for h in hits if not is_test_path(h.path)][:3] or [h.path for h in hits][:3]
        await emit("log", {"level": "info", "message": f"mock planner: {len(hits)} search hits"})
        note = f" Revised after feedback: {feedback}" if feedback else ""
        steps: list[PlanStep]
        if kind == "tests":
            targets = pick_targets(index, relevant)
            tests = [self._test_path(t) for t in targets]
            names = ", ".join(targets) or "the repository"
            steps = [
                PlanStep(id="s1", title="Survey modules to cover", files=targets,
                         detail=f"Pick modules most relevant to the task via code search.{note}"),
                PlanStep(id="s2", title=f"Write smoke tests for {names}", files=tests,
                         detail="Generate import + public-API smoke tests."),
                PlanStep(id="s3", title="Run the test suite", detail="Confirm the new tests pass."),
            ]  # fmt: skip
        elif kind in ("review", "explain"):
            steps = [
                PlanStep(id="s1", title="Locate relevant code", files=relevant,
                         detail=f"Search the repository for: {title}.{note}"),
                PlanStep(id="s2", title="Analyse findings", files=relevant,
                         detail="Run static rules and gather context."),
                PlanStep(id="s3", title="Summarise", detail="Write up the review/explanation."),
            ]  # fmt: skip
        else:
            steps = [
                PlanStep(id="s1", title="Review relevant code", files=relevant,
                         detail=f"Read the code most related to: {title}.{note}"),
                PlanStep(id="s2", title=f"Implement: {title}", files=relevant,
                         detail=(description or title)[:300]),
                PlanStep(id="s3", title="Verify with the test suite", detail="Run tests and review the diff."),
            ]  # fmt: skip
        summary = f"Mock plan for {kind} task “{title}” with {len(steps)} steps." + note
        self._count(query, summary)
        reqs = [f"WHEN the change is applied THEN {title.rstrip('.')} works as described",
                "WHEN the test suite runs THEN all tests pass"]
        return PlanResult(summary=summary, steps=steps, requirements=reqs,
                          design=f"Touch only: {', '.join(relevant) or 'the files found by search'}.")

    @staticmethod
    def _test_path(module: str) -> str:
        if module.endswith(".py"):
            return f"tests/test_devforge_smoke_{_slug(module)}.py"
        return f"test/devforge-smoke-{_slug(module)}.test.mjs"

    async def implement(self, ctx: WorkContext) -> str:
        if ctx.test_output is not None:
            await ctx.emit("log", {"level": "warn", "message": "mock provider cannot repair failing tests"})
            return "Mock provider made no repair."
        tools = WorkspaceTools(ctx.workspace, ctx.sandbox, ctx.emit)
        if ctx.kind == "tests":
            index = await asyncio.to_thread(RepoIndex.from_dir, ctx.workspace)
            preferred = [f for s in ctx.plan for f in s.files]
            targets = pick_targets(index, preferred)
            for target in targets:
                text = index.texts[target]
                if target.endswith(".py"):
                    await tools.execute("write_file", {
                        "path": self._test_path(target),
                        "content": python_smoke_test(target, _py_public_functions(text)),
                    })  # fmt: skip
                else:
                    await tools.execute("write_file", {
                        "path": self._test_path(target), "content": js_smoke_test(target, text),
                    })  # fmt: skip
            return f"Generated smoke tests for {len(targets)} module(s): {', '.join(targets) or 'none'}."
        steps = "\n".join(f"{i}. **{s.title}** — {s.detail}" for i, s in enumerate(ctx.plan, 1))
        files = sorted({f for s in ctx.plan for f in s.files})
        body = (
            "# DevForge change note (demo)\n\n"
            "> Written by the DevForge **mock** provider. A real provider would edit source files;\n"
            "> this note lets the full pipeline run offline.\n\n"
            f"- **Task kind:** {ctx.kind}\n- **Title:** {ctx.title}\n\n"
            f"## Description\n\n{ctx.description or '(none)'}\n\n"
            f"## Approved plan\n\n{steps}\n\n"
            f"## Relevant files\n\n{chr(10).join('- ' + f for f in files) or '- (none found)'}\n"
        )
        if ctx.feedback:
            body += f"\n## Reviewer feedback incorporated\n\n{ctx.feedback}\n"
        await tools.execute("write_file", {"path": NOTE_PATH, "content": body})
        return f"Wrote demo change note {NOTE_PATH}."

    async def analyze(self, index: RepoIndex, kind: str, title: str, description: str, emit: Emit) -> str:
        hits = index.bm25.search(f"{title} {task_text(description)}", limit=5)
        paths = list(dict.fromkeys(h.path for h in hits))
        findings: list[Finding] = []
        for p in paths:
            info = index.by_path(p)
            if info:
                findings += analyze_file(p, info.language, index.texts[p])
        health = index.health()
        lines = [f"**{kind.title()} of “{title}”** (mock provider, retrieval-grounded)", ""]
        lines.append(f"Repository health: {health['score']}/100 (grade {health['grade']}).")
        lines.append("Most relevant files: " + (", ".join(f"`{p}`" for p in paths) or "none found") + ".")
        if kind == "review":
            lines.append(f"Static analysis on those files found {len(findings)} issue(s).")
            lines += [f"- {_ref(f.path, f.line)} [{f.severity}] {f.title}" for f in findings[:10]]
        else:
            lines += [f"- {_ref(h.path, h.line)}: `{h.snippet.splitlines()[0][:100] if h.snippet else ''}`" for h in hits]
        text = "\n".join(lines)
        self._count(title, text)
        return text

    async def review(self, diff: str, index: RepoIndex | None) -> ReviewResult:
        comments = static_comments(diff, index)
        serious = sum(1 for c in comments if c.severity in ("medium", "high"))
        summary = (
            f"Reviewed {len(added_lines(diff))} changed file(s); {len(comments)} comment(s), "
            f"{serious} needing attention."
        )
        self._count(diff, summary)
        return ReviewResult(summary=summary, comments=comments)

    async def chat(self, index: RepoIndex, messages: list[ChatMessage]) -> ChatResult:
        question = next((m.content for m in reversed(messages) if m.role == "user"), "")
        hits = index.bm25.search(question, limit=5)
        if not hits:
            answer = "I could not find anything in the repository that matches your question."
            self._count(question, answer)
            return ChatResult(answer, [])
        lines = [f"Here is what the repository says about “{question[:120]}”:", ""]
        for h in hits:
            first = next((ln.strip() for ln in h.snippet.splitlines() if ln.strip()), "")
            lines.append(f"- {_ref(h.path, h.line)}: `{first[:120]}`")
        answer = "\n".join(lines)
        self._count(question, answer)
        return ChatResult(answer, [{"path": h.path, "line": h.line} for h in hits])

    async def explain(self, index: RepoIndex, path: str, question: str | None) -> str:
        info, text, _ = index.read(path)
        defs: list[str] = []
        if info.language == "Python":
            try:
                for n in ast.parse(text).body:
                    if isinstance(n, ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef):
                        doc = (ast.get_docstring(n) or "").splitlines()
                        kind = "class" if isinstance(n, ast.ClassDef) else "function"
                        defs.append(f"- {kind} `{n.name}` (line {n.lineno})" + (f": {doc[0]}" if doc else ""))
            except SyntaxError:
                pass
        else:
            for m in re.finditer(r"^(?:export\s+)?(?:async\s+)?(?:function|class)\s+(\w+)", text, re.M):
                defs.append(f"- `{m.group(1)}` (line {text[: m.start()].count(chr(10)) + 1})")
        graph = index.graph()
        imports = sorted(e["target"] for e in graph["edges"] if e["source"] == path)  # type: ignore[type-var]
        used_by = sorted(e["source"] for e in graph["edges"] if e["target"] == path)  # type: ignore[type-var]
        out = [f"`{path}` is a {info.language} file with {info.lines} lines (mock provider summary)."]
        if defs:
            out += ["", "Definitions:", *defs[:20]]
        if imports:
            out += ["", "Imports from this repo: " + ", ".join(f"`{p}`" for p in imports)]
        if used_by:
            out += ["", "Used by: " + ", ".join(f"`{p}`" for p in used_by)]
        if question:
            hits = [h for h in index.bm25.search(question, limit=20) if h.path == path][:3]
            out += ["", f"Regarding “{question}”:"]
            out += [f"- {_ref(h.path, h.line)}: `{h.snippet.splitlines()[0][:100]}`" for h in hits] or ["- no direct match in this file"]
        answer = "\n".join(out)
        self._count(question or path, answer)
        return answer

    async def find_bugs(self, index: RepoIndex, paths: list[str]) -> list[Finding]:
        return []


__all__ = ["NOTE_PATH", "MockBrain", "pick_targets"]
