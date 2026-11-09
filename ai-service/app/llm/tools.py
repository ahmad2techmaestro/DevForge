"""Workspace-confined tools for the real-provider loop."""

from __future__ import annotations

import difflib
import json
import os
import re
import shlex
from collections.abc import Callable
from pathlib import Path

from app.mcp.client import CURRENT_TOOLBOX, McpToolbox
from app.repo import gitops
from app.repo.files import IGNORED_DIRS, PathEscapeError, safe_join
from app.repo.search import BM25Index
from app.sandbox.base import Sandbox
from app.sandbox.runner import detect, run_tests
from app.security import redact, safe_args, scan_line, truncate
from app.types import Emit

DENYLIST: list[re.Pattern[str]] = [
    re.compile(p)
    for p in (
        r"\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(/|~|\$HOME|\*)(\s|$)",
        r"\brm\s+--no-preserve-root",
        r"(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b",
        r"\bsudo\b", r"\bsu\s+-?\w*\s*$", r"\bgit\s+push\b", r"\bssh\b", r"\bscp\b",
        r"\bmkfs\b", r"\bdd\s+if=", r":\(\)\s*\{", r"\bchmod\s+-R\s+777\s+/",
        r"\bshutdown\b", r"\breboot\b", r">\s*/dev/sd", r"\bnc\s+-[a-z]*e\b",
        r"\bdocker\b", r"\bgit\s+remote\b.*\b(add|set-url)\b", r"\bgit\s+config\b.*credential",
    )
]  # fmt: skip
MAX_READ = 60_000
MAX_RESULT = 20_000

_PATH = {"type": "string", "description": "Path relative to the repository root"}


def _tool(name: str, desc: str, props: dict[str, object], required: list[str]) -> dict[str, object]:
    return {
        "type": "function",
        "function": {
            "name": name, "description": desc,
            "parameters": {"type": "object", "properties": props, "required": required},
        },
    }  # fmt: skip


SCHEMAS: dict[str, dict[str, object]] = {
    "list_files": _tool("list_files", "List files under a directory (recursive, capped).",
                        {"path": {**_PATH, "description": "Directory; default repo root"}}, []),
    "read_file": _tool("read_file", "Read a text file, optionally a 1-based line range.",
                       {"path": _PATH, "start": {"type": "integer"}, "end": {"type": "integer"}}, ["path"]),
    "search_code": _tool("search_code", "BM25 search over code chunks.",
                         {"query": {"type": "string"}, "limit": {"type": "integer"}}, ["query"]),
    "write_file": _tool("write_file", "Create or overwrite a file with the given content.",
                        {"path": _PATH, "content": {"type": "string"}}, ["path", "content"]),
    "edit_file": _tool("edit_file", "Replace an exact, unique string in a file.",
                       {"path": _PATH, "old_string": {"type": "string"}, "new_string": {"type": "string"}},
                       ["path", "old_string", "new_string"]),
    "run_command": _tool("run_command", "Run a shell command inside the sandbox in the repo root.",
                         {"command": {"type": "string"}}, ["command"]),
    "run_tests": _tool("run_tests", "Run the repository's test suite in the sandbox.", {}, []),
    "git_diff": _tool("git_diff", "Show the current uncommitted diff.", {}, []),
}  # fmt: skip
READ_ONLY = ("list_files", "read_file", "search_code")


class ToolError(Exception):
    """Tool failure that is reported back to the model (not a crash)."""


def check_command(command: str) -> None:
    for pat in DENYLIST:
        if pat.search(command):
            raise ToolError("command blocked by sandbox policy")


class WorkspaceTools:
    def __init__(
        self, root: Path, sandbox: Sandbox, emit: Emit, *, timeout: float = 120.0,
        readonly: bool = False, secrets: tuple[str, ...] = (),
    ) -> None:
        self.root = root
        self.sandbox = sandbox
        self.emit = emit
        self.timeout = timeout
        self.readonly = readonly
        self.secrets = secrets
        self._bm25: BM25Index | None = None
        self.mcp: McpToolbox | None = CURRENT_TOOLBOX.get()

    def schemas(self) -> list[dict[str, object]]:
        names = READ_ONLY if self.readonly else tuple(SCHEMAS)
        extra = self.mcp.schemas(readonly=self.readonly) if self.mcp else []
        return [SCHEMAS[n] for n in names] + extra

    def resolve(self, rel: str) -> Path:
        try:
            return safe_join(self.root, rel)
        except PathEscapeError as e:
            raise ToolError(str(e)) from None

    def resolve_write(self, rel: str) -> Path:
        target = self.resolve(rel)
        parts = Path(os.path.relpath(target, os.path.realpath(self.root))).parts
        if parts and parts[0] == ".git":
            raise ToolError("writing inside .git is not allowed")
        return target

    # ---- dispatch ---------------------------------------------------------

    async def execute(self, name: str, args: dict[str, object]) -> tuple[bool, str]:
        await self.emit("tool.call", {"name": name, "args": safe_args(args)})
        allowed = READ_ONLY if self.readonly else tuple(SCHEMAS)
        try:
            if self.mcp and self.mcp.has(name):
                if self.readonly and not self.mcp.is_read_only(name):
                    raise ToolError("this MCP tool is not read-only and cannot run during planning")
                ok, text = await self.mcp.call(name, args)
                text = truncate(text, MAX_RESULT)
                summary = truncate(redact(text, self.secrets).replace("\n", " "), 200)
                await self.emit("tool.result", {"name": name, "ok": ok, "summary": summary})
                return ok, text
            if name not in allowed:
                raise ToolError(f"unknown or disallowed tool: {name}")
            handler: Callable[..., object] = getattr(self, f"_t_{name}")
            result = handler(**args) if not _is_async(handler) else await handler(**args)
            ok, text = True, str(result)
        except ToolError as e:
            ok, text = False, f"error: {e}"
        except TypeError as e:
            ok, text = False, f"error: bad arguments ({e})"
        except OSError as e:
            ok, text = False, f"error: {e.strerror or e}"
        text = truncate(text, MAX_RESULT)
        summary = truncate(redact(text, self.secrets).replace("\n", " "), 200)
        await self.emit("tool.result", {"name": name, "ok": ok, "summary": summary})
        return ok, text

    # ---- read tools -------------------------------------------------------

    def _t_list_files(self, path: str = "") -> str:
        base = self.resolve(path) if path else Path(os.path.realpath(self.root))
        if not base.is_dir():
            raise ToolError("not a directory")
        out: list[str] = []
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = sorted(d for d in dirnames if d not in IGNORED_DIRS)
            for f in sorted(filenames):
                out.append(os.path.relpath(os.path.join(dirpath, f), os.path.realpath(self.root)))
                if len(out) >= 500:
                    return "\n".join(out) + "\n[truncated at 500 files]"
        return "\n".join(out) or "(empty)"

    def _t_read_file(self, path: str, start: int | None = None, end: int | None = None) -> str:
        target = self.resolve(path)
        if not target.is_file():
            raise ToolError("file not found")
        if target.stat().st_size > 1_000_000:
            raise ToolError("file too large")
        lines = target.read_text("utf-8", errors="replace").splitlines()
        lo = max((start or 1) - 1, 0)
        hi = end if end else len(lines)
        body = "\n".join(f"{i + 1}\t{ln}" for i, ln in enumerate(lines[lo:hi], lo))
        return truncate(body, MAX_READ)

    def _t_search_code(self, query: str, limit: int = 8) -> str:
        if self._bm25 is None:
            from app.repo.files import iter_repo

            self._bm25 = BM25Index({i.path: t for i, t in iter_repo(self.root)})
        hits = self._bm25.search(query, min(max(limit, 1), 20))
        return "\n\n".join(f"{h.path}:{h.line}\n{h.snippet}" for h in hits) or "no matches"

    # ---- write tools ------------------------------------------------------

    async def _announce(self, rel: str, old: str, new: str) -> None:
        add = dele = 0
        for tag, a0, a1, b0, b1 in difflib.SequenceMatcher(
            None, old.splitlines(), new.splitlines(), autojunk=False
        ).get_opcodes():
            if tag != "equal":
                dele += a1 - a0
                add += b1 - b0
        self._bm25 = None
        await self.emit("file.changed", {"path": rel, "additions": add, "deletions": dele})

    @staticmethod
    def _check_content(content: str) -> None:
        for line in content.splitlines():
            rule = scan_line(line)
            if rule and rule != "hardcoded-secret":
                raise ToolError(f"refusing to write content that looks like a credential ({rule})")

    async def _t_write_file(self, path: str, content: str) -> str:
        if self.readonly:
            raise ToolError("read-only")
        target = self.resolve_write(path)
        self._check_content(content)
        old = target.read_text("utf-8", errors="replace") if target.is_file() else ""
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, "utf-8")
        await self._announce(path, old, content)
        return f"wrote {path} ({len(content)} bytes)"

    async def _t_edit_file(self, path: str, old_string: str, new_string: str) -> str:
        target = self.resolve_write(path)
        if not target.is_file():
            raise ToolError("file not found")
        text = target.read_text("utf-8")
        count = text.count(old_string)
        if not old_string or count != 1:
            raise ToolError(f"old_string must match exactly once (matched {count})")
        self._check_content(new_string)
        new = text.replace(old_string, new_string, 1)
        target.write_text(new, "utf-8")
        await self._announce(path, text, new)
        return f"edited {path}"

    # ---- exec tools -------------------------------------------------------

    async def _t_run_command(self, command: str) -> str:
        check_command(command)
        try:
            shlex.split(command)
        except ValueError as e:
            raise ToolError(f"unparseable command: {e}") from None
        res = await self.sandbox.run(["sh", "-c", command], self.root, timeout=self.timeout)
        return f"exit={res.exit_code}\n{res.output[-8000:]}"

    async def _t_run_tests(self) -> str:
        plan = detect(self.root)
        if plan is None:
            return "no test runner detected"
        out = await run_tests(self.sandbox, self.root, plan, self.timeout)
        return f"{'PASS' if out.ok else 'FAIL'} passed={out.passed} failed={out.failed}\n{out.output[-6000:]}"

    async def _t_git_diff(self) -> str:
        diff, _ = await gitops.working_diff(self.root)
        return diff[:MAX_RESULT] or "(no changes)"


def _is_async(fn: object) -> bool:
    import inspect

    return inspect.iscoroutinefunction(fn)


def parse_args(raw: object) -> dict[str, object]:
    if isinstance(raw, dict):
        return {str(k): v for k, v in raw.items()}
    if isinstance(raw, str):
        try:
            val = json.loads(raw or "{}")
        except ValueError:
            return {}
        return val if isinstance(val, dict) else {}
    return {}
