from __future__ import annotations

import asyncio
import json
import subprocess
import threading
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult

from app.config import Settings
from app.llm.provider import BrainFactory
from app.main import create_app

KEY = "test-key"
H = {"X-Internal-Key": KEY}

PY_FILES = {
    "README.md": "# Calc demo\n\nTiny calculator library.\n",
    "calc/__init__.py": "",
    "calc/ops.py": (
        '"""Arithmetic helpers."""\n\n\ndef add(a, b):\n    return a + b\n\n\n'
        "def multiply(a, b):\n    return a * b\n\n\ndef _private():\n    return 1\n"
    ),
    "calc/text.py": (
        "from calc.ops import add\n\n\ndef shout(s):\n    return s.upper() + '!'\n\n\n"
        "def total(items):\n    return add(len(items), 0)\n"
    ),
    "node_modules/junk/index.js": "console.log('ignored')\n",
    "logo.png": "\x89PNG\x00\x00binary",
}


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=T", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", *args],
        cwd=cwd, check=True, capture_output=True, text=True,
    ).stdout  # fmt: skip


def make_repo(root: Path, files: dict[str, str]) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    for rel, content in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, "utf-8")
    git(root, "init", "-q", "-b", "main")
    git(root, "add", "-A", "-f")
    git(root, "commit", "-q", "-m", "init")
    return root


@pytest.fixture
def py_repo(tmp_path: Path) -> Path:
    return make_repo(tmp_path / "src_py", PY_FILES)


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        internal_key=KEY, llm_provider="mock", workdir=tmp_path / "data", sandbox="subprocess",
        callback_backoff=0.01, command_timeout=60.0,
    )  # fmt: skip


class ScriptedChatModel(BaseChatModel):
    """Emits a fixed sequence of AIMessages (tool calls etc.) to drive the real-provider loop."""

    script: list[AIMessage]
    cursor: int = 0

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools: object, **kwargs: object) -> ScriptedChatModel:  # type: ignore[override]
        return self

    def _generate(self, messages: list[BaseMessage], stop: list[str] | None = None, run_manager: object = None, **kwargs: object) -> ChatResult:
        msg = self.script[min(self.cursor, len(self.script) - 1)]
        self.cursor += 1
        return ChatResult(generations=[ChatGeneration(message=msg)])


def ai(text: str = "", calls: list[tuple[str, dict[str, object]]] | None = None, i: int = 100, o: int = 50) -> AIMessage:
    tool_calls = [{"name": n, "args": a, "id": f"call_{k}_{n}", "type": "tool_call"} for k, (n, a) in enumerate(calls or [])]
    return AIMessage(content=text, tool_calls=tool_calls, usage_metadata={"input_tokens": i, "output_tokens": o, "total_tokens": i + o})


class Receiver:
    """Local HTTP server standing in for the API's /internal/runs/:id/events."""

    def __init__(self) -> None:
        self.events: list[dict[str, object]] = []
        self.keys: list[str | None] = []
        self.fail_first = 0
        self.attempts = 0
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                outer.attempts += 1
                if outer.fail_first > 0:
                    outer.fail_first -= 1
                    self.send_response(500)
                    self.end_headers()
                    return
                outer.events.append(json.loads(body))
                outer.keys.append(self.headers.get("X-Internal-Key"))
                self.send_response(200)
                self.end_headers()

            def log_message(self, *a: object) -> None:
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/internal/runs/r1/events"

    def types(self) -> list[str]:
        return [str(e["type"]) for e in self.events]


@pytest.fixture
def receiver() -> Receiver:
    r = Receiver()
    yield r  # type: ignore[misc]
    r.server.shutdown()


@asynccontextmanager
async def running(settings: Settings, brain_factory: BrainFactory | None = None, **kw: object) -> AsyncIterator[tuple[httpx.AsyncClient, FastAPI]]:
    app = create_app(settings, brain_factory=brain_factory, **kw)  # type: ignore[arg-type]
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://agent", headers=H) as c:
            yield c, app


@pytest.fixture
async def client(settings: Settings) -> AsyncIterator[httpx.AsyncClient]:
    async with running(settings) as (c, _):
        yield c


async def wait_for(pred: Callable[[], object], timeout: float = 30.0) -> None:
    async def poll() -> None:
        while True:
            res = pred()
            if asyncio.iscoroutine(res):
                res = await res
            if res:
                return
            await asyncio.sleep(0.05)

    await asyncio.wait_for(poll(), timeout)


async def index_repo(c: httpx.AsyncClient, path: Path, repo_id: str = "repo1") -> dict[str, object]:
    r = await c.post("/repos/index", json={"repoId": repo_id, "localPath": str(path)})
    assert r.status_code == 200, r.text
    return r.json()
