"""DevForge as an MCP server (stdio): give Claude Desktop, Cursor or any MCP client DevForge's repo intelligence.

    python -m app.mcp.server --repo /path/to/project

Tools: search_code (hybrid), find_symbols, impact_of_change, read_file, list_files, repo_health.
Read-only: nothing here writes to the repository.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from app.config import Settings
from app.errors import ApiError
from app.repo.embeddings import build_embedder
from app.repo.index import RepoIndex
from app.security import truncate

PROTOCOL = "2025-03-26"
_RO = {"readOnlyHint": True, "destructiveHint": False}


def _t(name: str, desc: str, props: dict[str, Any], req: list[str]) -> dict[str, Any]:
    return {"name": name, "description": desc, "annotations": _RO,
            "inputSchema": {"type": "object", "properties": props, "required": req}}  # fmt: skip


TOOLS = [
    _t("search_code", "Hybrid (keyword + semantic) code search. Returns path:line with snippets.",
       {"query": {"type": "string"}, "limit": {"type": "integer", "default": 8}}, ["query"]),
    _t("find_symbols", "List functions/classes/methods, optionally for one file.",
       {"path": {"type": "string"}}, []),
    _t("impact_of_change", "What depends on this file or symbol: direct, transitive, tests, risk.",
       {"path": {"type": "string"}, "symbol": {"type": "string"}}, ["path"]),
    _t("read_file", "Read a file (line-numbered).", {"path": {"type": "string"}}, ["path"]),
    _t("list_files", "List indexed files with language and line counts.",
       {"prefix": {"type": "string"}}, []),
    _t("repo_health", "Heuristic health score and metrics for the repository.", {}, []),
]


class DevForgeMcp:
    def __init__(self, root: Path) -> None:
        self.index = RepoIndex.from_dir(root)
        self.settings = Settings.from_env()

    async def call(self, name: str, a: dict[str, Any]) -> str:
        ix = self.index
        if name == "search_code":
            res = await ix.hybrid_search(str(a.get("query", "")), int(a.get("limit", 8)),
                                         build_embedder(self.settings))
            return "\n\n".join(f"{r['path']}:{r['line']}\n{r['snippet']}" for r in res["results"]) or "no matches"
        if name == "find_symbols":
            return json.dumps(ix.intel().symbols(a.get("path") or None), indent=1)[:20_000]  # type: ignore[attr-defined]
        if name == "impact_of_change":
            return json.dumps(ix.intel().impact(str(a["path"]), a.get("symbol") or None), indent=1)[:20_000]  # type: ignore[attr-defined]
        if name == "read_file":
            _, text, _ = ix.read(str(a["path"]))
            return "\n".join(f"{i}\t{ln}" for i, ln in enumerate(text.splitlines(), 1))
        if name == "list_files":
            pre = str(a.get("prefix", ""))
            return "\n".join(f"{f.path}  ({f.language}, {f.lines} lines)" for f in ix.files if f.path.startswith(pre)) or "(none)"
        if name == "repo_health":
            return json.dumps(ix.health(), indent=1)[:20_000]
        raise KeyError(name)

    async def handle(self, msg: dict[str, Any]) -> dict[str, Any] | None:
        method, rid = msg.get("method"), msg.get("id")
        if rid is None:
            return None  # notifications need no reply

        def ok(result: Any) -> dict[str, Any]:
            return {"jsonrpc": "2.0", "id": rid, "result": result}

        def err(code: int, text: str) -> dict[str, Any]:
            return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": text}}

        if method == "initialize":
            return ok({"protocolVersion": PROTOCOL, "capabilities": {"tools": {}},
                       "serverInfo": {"name": "devforge", "version": "1.0.0"}})  # fmt: skip
        if method == "ping":
            return ok({})
        if method == "tools/list":
            return ok({"tools": TOOLS})
        if method == "tools/call":
            p = msg.get("params") or {}
            try:
                text = await self.call(str(p.get("name")), p.get("arguments") or {})
                return ok({"content": [{"type": "text", "text": truncate(text, 60_000)}], "isError": False})
            except KeyError as e:
                if str(e.args[0]) in {t["name"] for t in TOOLS} and e.args[0] != p.get("name"):
                    return ok({"content": [{"type": "text", "text": f"missing argument {e}"}], "isError": True})
                return err(-32602, f"unknown tool: {p.get('name')}")
            except ApiError as e:
                return ok({"content": [{"type": "text", "text": f"error: {e}"}], "isError": True})
        return err(-32601, f"method not found: {method}")


async def serve(root: Path) -> None:
    app = DevForgeMcp(root)
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=8 * 1024 * 1024)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    while True:
        line = await reader.readline()
        if not line:
            return
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if not isinstance(msg, dict):
            continue
        reply = await app.handle(msg)
        if reply is not None:
            sys.stdout.write(json.dumps(reply) + "\n")
            sys.stdout.flush()


def main() -> None:
    ap = argparse.ArgumentParser(description="DevForge MCP server (stdio)")
    ap.add_argument("--repo", required=True, help="path to the repository to expose")
    root = Path(ap.parse_args().repo).resolve()
    if not root.is_dir():
        sys.exit(f"not a directory: {root}")
    asyncio.run(serve(root))


if __name__ == "__main__":
    main()
