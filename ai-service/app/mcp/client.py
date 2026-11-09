"""A small, dependency-free MCP client (JSON-RPC 2.0) with stdio and streamable-HTTP transports.

Implements what agents need: initialize, tools/list, tools/call. Spec: modelcontextprotocol.io.
Stdio servers run as child processes with a scrubbed environment plus only the env the user configured.
"""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import json
import os
import re
import socket
from contextvars import ContextVar
from typing import Any, Literal
from urllib.parse import urlparse

import httpx
from pydantic import BaseModel, Field, field_validator

from app.errors import ApiError
from app.security import redact, truncate

PROTOCOL_VERSION = "2025-03-26"
CLIENT_INFO = {"name": "devforge", "version": "1.0.0"}
MAX_TOOLS_PER_SERVER = 64
MAX_RESULT = 20_000
_SLUG = re.compile(r"[^a-zA-Z0-9_]+")


class McpError(Exception):
    """MCP connection or protocol failure (message is safe to show; secrets are redacted)."""


class McpServerConfig(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    transport: Literal["stdio", "http"] = "stdio"
    command: str = ""
    args: list[str] = Field(default_factory=list, max_length=40)
    env: dict[str, str] = Field(default_factory=dict)
    url: str = ""
    headers: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True

    @field_validator("name")
    @classmethod
    def _slug(cls, v: str) -> str:
        s = _SLUG.sub("_", v.strip()).strip("_").lower()
        if not s:
            raise ValueError("name must contain letters or digits")
        return s[:32]


class McpPolicy(BaseModel):
    allow_stdio: bool = False
    allow_private_http: bool = False


def check_http_url(url: str, policy: McpPolicy) -> None:
    """SSRF guard: http(s) only, and no loopback/private/link-local targets unless explicitly allowed."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise McpError("MCP url must be http(s)")
    if policy.allow_private_http:
        return
    host = parsed.hostname
    try:
        infos = socket.getaddrinfo(host, parsed.port or 443, proto=socket.IPPROTO_TCP)
    except OSError:
        raise McpError(f"cannot resolve {host}") from None
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise McpError("MCP url points to a private address (set MCP_ALLOW_PRIVATE=true to allow it)")


def _scrubbed_env(extra: dict[str, str]) -> dict[str, str]:
    env = {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/tmp"),
           "LANG": "C.UTF-8", "NO_COLOR": "1"}  # fmt: skip
    if os.name == "nt":
        for k in ("SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA"):
            if k in os.environ:
                env[k] = os.environ[k]
    env.update(extra)
    return env


class McpClient:
    def __init__(self, cfg: McpServerConfig, policy: McpPolicy, *, timeout: float = 30.0) -> None:
        self.cfg = cfg
        self.policy = policy
        self.timeout = timeout
        self.server_info: dict[str, Any] = {}
        self._next = 0
        self._proc: asyncio.subprocess.Process | None = None
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._reader: asyncio.Task[None] | None = None
        self._stderr: list[str] = []
        self._http: httpx.AsyncClient | None = None
        self._session: str | None = None

    # ---- lifecycle -----------------------------------------------------------------

    async def connect(self) -> None:
        if self.cfg.transport == "stdio":
            if not self.policy.allow_stdio:
                raise McpError("stdio MCP servers are disabled on this deployment (MCP_ALLOW_STDIO=false)")
            if not self.cfg.command.strip():
                raise McpError("command is required for a stdio server")
            try:
                self._proc = await asyncio.create_subprocess_exec(
                    self.cfg.command, *self.cfg.args,
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE, env=_scrubbed_env(self.cfg.env),
                    limit=4 * 1024 * 1024,
                )  # fmt: skip
            except (FileNotFoundError, PermissionError) as e:
                raise McpError(f"cannot start '{self.cfg.command}': {e.strerror or e}") from None
            self._reader = asyncio.create_task(self._read_stdout())
            asyncio.create_task(self._drain_stderr())  # noqa: RUF006 - ends with the process
        else:
            check_http_url(self.cfg.url, self.policy)
            self._http = httpx.AsyncClient(timeout=self.timeout, follow_redirects=False)
        result = await self._request("initialize", {
            "protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": CLIENT_INFO,
        })  # fmt: skip
        self.server_info = result.get("serverInfo", {}) if isinstance(result, dict) else {}
        await self._notify("notifications/initialized")

    async def close(self) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.cancel()
        if self._reader:
            self._reader.cancel()
        if self._proc and self._proc.returncode is None:
            with contextlib.suppress(Exception):
                if self._proc.stdin:
                    self._proc.stdin.close()
            with contextlib.suppress(ProcessLookupError):
                self._proc.terminate()
            try:
                await asyncio.wait_for(self._proc.wait(), 3)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    self._proc.kill()
        if self._http:
            await self._http.aclose()

    # ---- public API ----------------------------------------------------------------

    async def list_tools(self) -> list[dict[str, Any]]:
        tools: list[dict[str, Any]] = []
        cursor: str | None = None
        for _ in range(10):
            res = await self._request("tools/list", {"cursor": cursor} if cursor else {})
            batch = res.get("tools", []) if isinstance(res, dict) else []
            tools += [t for t in batch if isinstance(t, dict) and isinstance(t.get("name"), str)]
            cursor = res.get("nextCursor") if isinstance(res, dict) else None
            if not cursor or len(tools) >= MAX_TOOLS_PER_SERVER:
                break
        return tools[:MAX_TOOLS_PER_SERVER]

    async def call_tool(self, name: str, args: dict[str, Any], timeout: float = 120.0) -> tuple[bool, str]:
        res = await self._request("tools/call", {"name": name, "arguments": args}, timeout=timeout)
        if not isinstance(res, dict):
            return False, "invalid tool result"
        parts: list[str] = []
        for block in res.get("content", []) or []:
            if not isinstance(block, dict):
                continue
            kind = block.get("type")
            if kind == "text":
                parts.append(str(block.get("text", "")))
            elif kind == "resource":
                r = block.get("resource") or {}
                parts.append(str(r.get("text") or r.get("uri") or "[resource]"))
            else:
                parts.append(f"[{kind or 'content'} omitted]")
        if not parts and res.get("structuredContent") is not None:
            parts.append(json.dumps(res["structuredContent"])[:MAX_RESULT])
        return (not res.get("isError", False)), truncate("\n".join(parts) or "(no output)", MAX_RESULT)

    # ---- JSON-RPC ------------------------------------------------------------------

    async def _request(self, method: str, params: dict[str, Any], timeout: float | None = None) -> Any:
        self._next += 1
        rid = self._next
        msg = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}
        limit = timeout or self.timeout
        if self.cfg.transport == "http":
            return await self._http_request(msg, rid, limit)
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        try:
            await self._write(msg)
            return await asyncio.wait_for(fut, limit)
        except TimeoutError:
            raise McpError(f"{method} timed out after {limit:.0f}s{self._stderr_hint()}") from None
        finally:
            self._pending.pop(rid, None)

    async def _notify(self, method: str) -> None:
        msg = {"jsonrpc": "2.0", "method": method}
        if self.cfg.transport == "http":
            with contextlib.suppress(Exception):
                assert self._http is not None
                await self._http.post(self.cfg.url, json=msg, headers=self._headers())
            return
        await self._write(msg)

    async def _write(self, msg: dict[str, Any]) -> None:
        if not self._proc or not self._proc.stdin or self._proc.returncode is not None:
            raise McpError(f"server exited{self._stderr_hint()}")
        self._proc.stdin.write((json.dumps(msg) + "\n").encode())
        await self._proc.stdin.drain()

    async def _read_stdout(self) -> None:
        assert self._proc and self._proc.stdout
        try:
            while True:
                line = await self._proc.stdout.readline()
                if not line:
                    break
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue  # servers may print banners; ignore non-JSON lines
                if not isinstance(msg, dict):
                    continue
                if "id" in msg and ("result" in msg or "error" in msg):
                    fut = self._pending.get(msg["id"]) if isinstance(msg["id"], int) else None
                    if fut and not fut.done():
                        if "error" in msg:
                            fut.set_exception(McpError(_rpc_error(msg["error"])))
                        else:
                            fut.set_result(msg["result"])
                elif "id" in msg and "method" in msg:  # server -> client request
                    reply: dict[str, Any] = {"jsonrpc": "2.0", "id": msg["id"]}
                    if msg["method"] == "ping":
                        reply["result"] = {}
                    else:
                        reply["error"] = {"code": -32601, "message": "method not supported by DevForge"}
                    with contextlib.suppress(Exception):
                        await self._write(reply)
        finally:
            err = McpError(f"server closed the connection{self._stderr_hint()}")
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(err)

    async def _drain_stderr(self) -> None:
        assert self._proc and self._proc.stderr
        while True:
            line = await self._proc.stderr.readline()
            if not line:
                return
            self._stderr = (self._stderr + [line.decode("utf-8", "replace").rstrip()])[-8:]

    def _stderr_hint(self) -> str:
        tail = " | ".join(self._stderr[-3:])
        return f" (stderr: {redact(truncate(tail, 300))})" if tail else ""

    # ---- HTTP ------------------------------------------------------------------------

    def _headers(self) -> dict[str, str]:
        h = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json",
             **self.cfg.headers}  # fmt: skip
        if self._session:
            h["Mcp-Session-Id"] = self._session
        return h

    async def _http_request(self, msg: dict[str, Any], rid: int, limit: float) -> Any:
        assert self._http is not None
        try:
            resp = await self._http.post(self.cfg.url, json=msg, headers=self._headers(), timeout=limit)
        except httpx.HTTPError as e:
            raise McpError(f"HTTP error: {type(e).__name__}") from None
        if resp.status_code in (401, 403):
            raise McpError(f"server rejected the credentials (HTTP {resp.status_code})")
        if resp.status_code >= 400:
            raise McpError(f"server returned HTTP {resp.status_code}")
        self._session = resp.headers.get("mcp-session-id", self._session)
        payloads: list[Any] = []
        if "text/event-stream" in resp.headers.get("content-type", ""):
            for line in resp.text.splitlines():
                if line.startswith("data:"):
                    with contextlib.suppress(ValueError):
                        payloads.append(json.loads(line[5:].strip()))
        else:
            with contextlib.suppress(ValueError):
                body = resp.json()
                payloads = body if isinstance(body, list) else [body]
        for p in payloads:
            if isinstance(p, dict) and p.get("id") == rid:
                if "error" in p:
                    raise McpError(_rpc_error(p["error"]))
                return p.get("result")
        raise McpError("no response from server")


def _rpc_error(err: object) -> str:
    if isinstance(err, dict):
        return redact(truncate(f"{err.get('message', 'error')} (code {err.get('code')})", 300))
    return "error"


# ---- toolbox: many servers, one tool namespace -----------------------------------------


def _fn_name(server: str, tool: str) -> str:
    return f"mcp__{server}__{_SLUG.sub('_', tool)}"[:64]


class McpToolbox:
    """Connected servers exposed to the agent loop as OpenAI-style function tools."""

    def __init__(self) -> None:
        self.clients: dict[str, McpClient] = {}
        self._tools: dict[str, tuple[str, str, bool]] = {}  # fn name -> (server, tool, read_only)
        self._schemas: dict[str, dict[str, object]] = {}
        self.errors: dict[str, str] = {}

    @classmethod
    async def open(cls, configs: list[McpServerConfig], policy: McpPolicy) -> McpToolbox:
        box = cls()

        async def one(cfg: McpServerConfig) -> None:
            client = McpClient(cfg, policy)
            try:
                await client.connect()
                tools = await client.list_tools()
            except (McpError, ApiError, OSError) as e:
                box.errors[cfg.name] = str(e)
                await client.close()
                return
            box.clients[cfg.name] = client
            for t in tools:
                fn = _fn_name(cfg.name, str(t["name"]))
                ann = t.get("annotations") if isinstance(t.get("annotations"), dict) else {}
                box._tools[fn] = (cfg.name, str(t["name"]), bool(ann.get("readOnlyHint", False)))
                schema = t.get("inputSchema") if isinstance(t.get("inputSchema"), dict) else {}
                box._schemas[fn] = {"type": "function", "function": {
                    "name": fn,
                    "description": truncate(f"[MCP:{cfg.name}] {t.get('description') or t['name']}", 900),
                    "parameters": schema or {"type": "object", "properties": {}},
                }}  # fmt: skip

        await asyncio.gather(*(one(c) for c in configs if c.enabled))
        return box

    def schemas(self, readonly: bool = False) -> list[dict[str, object]]:
        return [s for fn, s in self._schemas.items() if not readonly or self._tools[fn][2]]

    def has(self, fn: str) -> bool:
        return fn in self._tools

    def is_read_only(self, fn: str) -> bool:
        return self._tools[fn][2]

    async def call(self, fn: str, args: dict[str, Any]) -> tuple[bool, str]:
        server, tool, _ = self._tools[fn]
        try:
            return await self.clients[server].call_tool(tool, args)
        except McpError as e:
            return False, f"error: {e}"

    async def close(self) -> None:
        await asyncio.gather(*(c.close() for c in self.clients.values()), return_exceptions=True)


CURRENT_TOOLBOX: ContextVar[McpToolbox | None] = ContextVar("devforge_mcp_toolbox", default=None)


async def inspect_server(cfg: McpServerConfig, policy: McpPolicy) -> dict[str, Any]:
    """Connect once, list tools, disconnect. Used by the 'Test connection' button."""
    client = McpClient(cfg, policy, timeout=20.0)
    try:
        await client.connect()
        tools = await client.list_tools()
    finally:
        await client.close()
    return {
        "server": client.server_info,
        "tools": [{"name": t["name"], "description": str(t.get("description", ""))[:400],
                   "readOnly": bool((t.get("annotations") or {}).get("readOnlyHint", False))} for t in tools],
    }  # fmt: skip
