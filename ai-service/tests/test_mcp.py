import json
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from app.mcp import client as mc
from app.mcp.client import (
    CURRENT_TOOLBOX,
    McpClient,
    McpError,
    McpPolicy,
    McpServerConfig,
    McpToolbox,
    check_http_url,
)

FAKE = str(Path(__file__).parent / "fake_mcp.py")
ALLOW = McpPolicy(allow_stdio=True)


def stdio(name="fake", **kw):
    return McpServerConfig(name=name, command=sys.executable, args=[FAKE], **kw)


async def test_stdio_list_and_call():
    c = McpClient(stdio(), ALLOW)
    await c.connect()
    try:
        assert c.server_info["name"] == "fake"
        tools = await c.list_tools()
        assert {t["name"] for t in tools} == {"echo", "add", "boom", "token_len"}
        assert await c.call_tool("echo", {"text": "hi"}) == (True, "hi")
        assert await c.call_tool("add", {"a": 2, "b": 3}) == (True, "5")
        ok, text = await c.call_tool("boom", {})
        assert not ok and text == "kaboom"
        with pytest.raises(McpError, match="nope"):
            await c._request("unknown/method", {})
    finally:
        await c.close()


async def test_stdio_disabled_by_policy():
    with pytest.raises(McpError, match="disabled"):
        await McpClient(stdio(), McpPolicy()).connect()


async def test_bad_command_is_a_clean_error():
    with pytest.raises(McpError, match="cannot start"):
        await McpClient(McpServerConfig(name="x", command="definitely-not-a-binary"), ALLOW).connect()


async def test_env_is_scrubbed_but_configured_env_passes(monkeypatch):
    monkeypatch.setenv("SECRET_PARENT", "1")
    c = McpClient(stdio(env={"FAKE_TOKEN": "abcd"}), ALLOW)
    await c.connect()
    try:
        ok, text = await c.call_tool("token_len", {})
        assert ok and text.startswith("4") and "HOME=False" in text
    finally:
        await c.close()


async def test_server_exit_reports_instead_of_hanging():
    cfg = McpServerConfig(name="dies", command=sys.executable, args=["-c", "import sys; sys.stderr.write('bad config'); sys.exit(3)"])
    with pytest.raises(McpError, match="bad config|closed|exited"):
        await McpClient(cfg, ALLOW).connect()


async def test_toolbox_namespaces_filters_and_reports_errors():
    box = await McpToolbox.open([stdio("My Server!"), McpServerConfig(name="broken", command="nope-nope"),
                                 stdio("off", enabled=False)], ALLOW)
    try:
        names = {s["function"]["name"] for s in box.schemas()}  # type: ignore[index]
        assert "mcp__my_server__echo" in names and "mcp__my_server__add" in names
        assert not any("off" in n for n in names)
        assert "broken" in box.errors
        ro = {s["function"]["name"] for s in box.schemas(readonly=True)}  # type: ignore[index]
        assert ro == {"mcp__my_server__echo"}
        assert await box.call("mcp__my_server__add", {"a": 1, "b": 2}) == (True, "3")
    finally:
        await box.close()


async def test_workspace_tools_expose_and_gate_mcp(tmp_path):
    from app.llm.tools import WorkspaceTools
    from app.sandbox.subprocess_sandbox import SubprocessSandbox

    events: list[tuple[str, dict]] = []

    async def emit(t, d):
        events.append((t, d))

    box = await McpToolbox.open([stdio("fake")], ALLOW)
    tok = CURRENT_TOOLBOX.set(box)
    try:
        rw = WorkspaceTools(tmp_path, SubprocessSandbox(), emit)
        ro = WorkspaceTools(tmp_path, SubprocessSandbox(), emit, readonly=True)
        assert "mcp__fake__add" in {s["function"]["name"] for s in rw.schemas()}  # type: ignore[index]
        assert {s["function"]["name"] for s in ro.schemas()} >= {"mcp__fake__echo"}  # type: ignore[index]
        assert "mcp__fake__add" not in {s["function"]["name"] for s in ro.schemas()}  # type: ignore[index]
        assert await rw.execute("mcp__fake__add", {"a": 4, "b": 5}) == (True, "9")
        ok, text = await ro.execute("mcp__fake__add", {"a": 1, "b": 1})
        assert not ok and "not read-only" in text
        assert any(t == "tool.result" and d["name"] == "mcp__fake__add" and d["ok"] for t, d in events)
    finally:
        CURRENT_TOOLBOX.reset(tok)
        await box.close()


def test_http_url_guard():
    for bad in ("ftp://x.com/a", "http://127.0.0.1:9/mcp", "http://localhost/mcp", "http://169.254.169.254/latest", "http://10.0.0.5/x"):
        with pytest.raises(McpError):
            check_http_url(bad, McpPolicy())
    check_http_url("http://127.0.0.1:9/mcp", McpPolicy(allow_private_http=True))


def _http_app(sse: bool) -> FastAPI:
    app = FastAPI()

    @app.post("/mcp")
    async def mcp(request: Request):
        if request.headers.get("authorization") != "Bearer tok":
            return JSONResponse({"error": "no"}, status_code=401)
        msg = await request.json()
        if "id" not in msg:
            return JSONResponse({}, status_code=202)
        m = msg["method"]
        if m == "initialize":
            res = {"serverInfo": {"name": "web", "version": "1"}, "capabilities": {}}
        elif m == "tools/list":
            res = {"tools": [{"name": "ping", "description": "p", "inputSchema": {"type": "object"}}]}
        else:
            res = {"content": [{"type": "text", "text": "pong"}]}
        body = {"jsonrpc": "2.0", "id": msg["id"], "result": res}
        headers = {"Mcp-Session-Id": "s1"}
        if sse:
            return StreamingResponse(iter([f"event: message\ndata: {json.dumps(body)}\n\n"]), media_type="text/event-stream", headers=headers)
        return JSONResponse(body, headers=headers)

    return app


@pytest.mark.parametrize("sse", [False, True])
async def test_http_transport(monkeypatch, sse):
    transport = httpx.ASGITransport(app=_http_app(sse))
    real = httpx.AsyncClient
    monkeypatch.setattr(mc.httpx, "AsyncClient", lambda **kw: real(transport=transport, **kw))
    cfg = McpServerConfig(name="web", transport="http", url="http://test/mcp", headers={"Authorization": "Bearer tok"})
    c = McpClient(cfg, McpPolicy(allow_private_http=True))
    await c.connect()
    try:
        assert (await c.list_tools())[0]["name"] == "ping"
        assert await c.call_tool("ping", {}) == (True, "pong")
        assert c._session == "s1"
    finally:
        await c.close()
    bad = McpClient(McpServerConfig(name="web", transport="http", url="http://test/mcp"), McpPolicy(allow_private_http=True))
    with pytest.raises(McpError, match="credentials"):
        await bad.connect()


async def test_devforge_mcp_server_end_to_end(tmp_path):
    (tmp_path / "pricing.py").write_text("def total(items):\n    return sum(i for i in items)\n")
    (tmp_path / "orders.py").write_text("from pricing import total\n\ndef place(items):\n    return total(items)\n")
    (tmp_path / "test_orders.py").write_text("from orders import place\n\ndef test_place():\n    assert place([1]) == 1\n")
    cfg = McpServerConfig(name="df", command=sys.executable, args=["-m", "app.mcp.server", "--repo", str(tmp_path)],
                          env={"PYTHONPATH": str(Path(__file__).parents[1]), "LLM_PROVIDER": "mock"})
    c = McpClient(cfg, ALLOW, timeout=60)
    await c.connect()
    try:
        names = {t["name"] for t in await c.list_tools()}
        assert {"search_code", "find_symbols", "impact_of_change", "read_file", "list_files", "repo_health"} <= names
        ok, text = await c.call_tool("search_code", {"query": "total items"})
        assert ok and "pricing.py" in text
        ok, text = await c.call_tool("impact_of_change", {"path": "pricing.py"})
        assert ok and "orders.py" in text
        ok, text = await c.call_tool("read_file", {"path": "pricing.py"})
        assert ok and text.startswith("1\tdef total")
        ok, text = await c.call_tool("read_file", {"path": "../etc/passwd"})
        assert not ok
    finally:
        await c.close()


async def test_inspect_route(settings):
    from tests.conftest import running

    body = {"name": "fake", "command": sys.executable, "args": [FAKE]}
    async with running(settings) as (c, _):
        r = await c.post("/mcp/inspect", json=body)
        assert r.status_code == 502 and "disabled" in r.json()["error"]["message"]
    settings.mcp_allow_stdio = True
    async with running(settings) as (c, _):
        r = await c.post("/mcp/inspect", json=body)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["server"]["name"] == "fake"
        assert {t["name"] for t in data["tools"]} == {"echo", "add", "boom", "token_len"}
        assert next(t for t in data["tools"] if t["name"] == "echo")["readOnly"] is True
        assert (await c.post("/mcp/inspect", json={"name": "x", "command": "nope-nope"})).status_code == 502


async def test_run_uses_mcp_tool_end_to_end(settings, py_repo, receiver):
    from app.llm.provider import BrainFactory  # noqa: F401
    from tests.conftest import ScriptedChatModel, ai

    settings.mcp_allow_stdio = True
    seen: list[dict] = []
    original_bind = ScriptedChatModel.bind_tools

    def spy(self, tools, **kw):
        seen.append({t["function"]["name"] for t in tools})
        return original_bind(self, tools, **kw)

    ScriptedChatModel.bind_tools = spy  # type: ignore[method-assign]
    try:
        model = ScriptedChatModel(script=[ai("", [("mcp__fake__add", {"a": 20, "b": 22})]), ai("The sum is 42.")])
        from app.llm.loop import run_tool_loop
        from app.llm.tools import WorkspaceTools
        from app.llm.usage import UsageMeter
        from app.sandbox.subprocess_sandbox import SubprocessSandbox

        events: list[tuple[str, dict]] = []

        async def emit(t, d):
            events.append((t, d))

        box = await McpToolbox.open([stdio("fake")], ALLOW)
        tok = CURRENT_TOOLBOX.set(box)
        try:
            tools = WorkspaceTools(py_repo, SubprocessSandbox(), emit)
            out = await run_tool_loop(model, "sys", "add 20 and 22", tools, UsageMeter("m"), emit,
                                      max_iterations=5, token_budget=10_000)
        finally:
            CURRENT_TOOLBOX.reset(tok)
            await box.close()
        assert out == "The sum is 42."
        assert "mcp__fake__add" in seen[0]
        assert ("tool.result", {"name": "mcp__fake__add", "ok": True, "summary": "42"}) in events
    finally:
        ScriptedChatModel.bind_tools = original_bind  # type: ignore[method-assign]
