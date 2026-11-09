"""Local fake OpenAI-compatible server for end-to-end tests of the REAL ChatOpenAI client.

Usage (also see the `fake_openai` fixture in tests/test_providers.py):

    with FakeOpenAI() as fake:                       # starts uvicorn on 127.0.0.1:<random port>
        fake.base_url                                # "http://127.0.0.1:PORT" (use as OPENAI_BASE_URL)
        fake.queue(text("hello"))                    # reply to the next POST /chat/completions
        fake.queue(tool_call("write_file", {...}))   # a tool_calls round trip
        fake.queue(error(429, retry_after=0))        # HTTP error, optional Retry-After header
        fake.requests                                # every recorded request: Recorded(path, headers, body)
        fake.chat_requests                           # only /chat/completions bodies (dicts)
        fake.models_seen                             # the "model" field of each chat request, in order
        fake.expected_key = "secret"                 # reject other Bearer keys with 401

    When the queue is empty, /chat/completions answers with text "ok". The queue is FIFO.
    POST /embeddings returns deterministic vectors (EMBED_DIM floats, derived from a hash of the
    input text) with the OpenAI response shape. Routes are also served under /v1/.
    Responses carry a `usage` block (prompt_tokens / completion_tokens, configurable per reply).
    Pure Python + uvicorn; works on Windows.
"""

from __future__ import annotations

import hashlib
import json
import socket
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

EMBED_DIM = 16


@dataclass
class Reply:
    text: str | None = None
    tool_calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    status: int = 200
    retry_after: float | None = None
    prompt_tokens: int = 100
    completion_tokens: int = 20
    delay: float = 0.0


@dataclass
class Recorded:
    path: str
    headers: dict[str, str]
    body: dict[str, Any]


def text(content: str, **kw: Any) -> Reply:
    return Reply(text=content, **kw)


def tool_call(name: str, args: dict[str, Any], *more: tuple[str, dict[str, Any]], **kw: Any) -> Reply:
    return Reply(tool_calls=[(name, args), *more], **kw)


def error(status: int, retry_after: float | None = None) -> Reply:
    return Reply(status=status, retry_after=retry_after)


def embed(s: str) -> list[float]:
    """Deterministic unit-ish vector for a string."""
    digest = hashlib.sha256(s.encode("utf-8")).digest()
    return [round((digest[i] - 127.5) / 127.5, 6) for i in range(EMBED_DIM)]


class FakeOpenAI:
    def __init__(self) -> None:
        self.script: deque[Reply] = deque()
        self.requests: list[Recorded] = []
        self.expected_key: str | None = None
        self._lock = threading.Lock()
        self._counter = 0
        self.app = self._build()
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        self._sock = sock
        self.port: int = sock.getsockname()[1]
        self._server = uvicorn.Server(uvicorn.Config(self.app, log_level="error", lifespan="off"))
        self._thread = threading.Thread(target=lambda: self._server.run(sockets=[sock]), daemon=True)

    # ---- public API -------------------------------------------------------
    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def chat_requests(self) -> list[dict[str, Any]]:
        return [r.body for r in self.requests if r.path.endswith("/chat/completions")]

    @property
    def models_seen(self) -> list[str]:
        return [str(b.get("model")) for b in self.chat_requests]

    def queue(self, *replies: Reply) -> None:
        with self._lock:
            self.script.extend(replies)

    def start(self) -> FakeOpenAI:
        self._thread.start()
        deadline = time.time() + 10
        while not self._server.started and time.time() < deadline:
            time.sleep(0.01)
        return self

    def stop(self) -> None:
        self._server.should_exit = True
        self._thread.join(timeout=5)
        self._sock.close()

    def __enter__(self) -> FakeOpenAI:
        return self.start()

    def __exit__(self, *a: object) -> None:
        self.stop()

    # ---- server -----------------------------------------------------------
    def _next_id(self) -> int:
        with self._lock:
            self._counter += 1
            return self._counter

    def _build(self) -> FastAPI:
        app = FastAPI()

        def unauthorized(request: Request) -> JSONResponse | None:
            if self.expected_key is None:
                return None
            if request.headers.get("authorization") == f"Bearer {self.expected_key}":
                return None
            return JSONResponse(
                {"error": {"message": "Incorrect API key provided", "type": "invalid_request_error",
                           "code": "invalid_api_key"}}, status_code=401)

        async def chat(request: Request) -> JSONResponse:
            body = await request.json()
            self.requests.append(Recorded(request.url.path, dict(request.headers), body))
            if (denied := unauthorized(request)) is not None:
                return denied
            with self._lock:
                reply = self.script.popleft() if self.script else Reply(text="ok")
            if reply.delay:
                time.sleep(reply.delay)
            if reply.status != 200:
                headers = {"Retry-After": str(reply.retry_after)} if reply.retry_after is not None else {}
                return JSONResponse({"error": {"message": f"fake error {reply.status}", "type": "fake"}},
                                    status_code=reply.status, headers=headers)
            n = self._next_id()
            message: dict[str, Any] = {"role": "assistant", "content": reply.text}
            finish = "stop"
            if reply.tool_calls:
                finish = "tool_calls"
                message["tool_calls"] = [
                    {"id": f"call_{n}_{k}", "type": "function",
                     "function": {"name": name, "arguments": json.dumps(args)}}
                    for k, (name, args) in enumerate(reply.tool_calls)
                ]
            return JSONResponse({
                "id": f"chatcmpl-{n}", "object": "chat.completion", "created": int(time.time()),
                "model": body.get("model", "fake"),
                "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                "usage": {"prompt_tokens": reply.prompt_tokens, "completion_tokens": reply.completion_tokens,
                          "total_tokens": reply.prompt_tokens + reply.completion_tokens},
            })

        async def embeddings(request: Request) -> JSONResponse:
            body = await request.json()
            self.requests.append(Recorded(request.url.path, dict(request.headers), body))
            if (denied := unauthorized(request)) is not None:
                return denied
            raw = body.get("input", [])
            inputs = [raw] if isinstance(raw, str) else list(raw)
            data = [{"object": "embedding", "index": i, "embedding": embed(str(t))} for i, t in enumerate(inputs)]
            tokens = sum(len(str(t).split()) for t in inputs)
            return JSONResponse({"object": "list", "data": data, "model": body.get("model", "fake-embed"),
                                 "usage": {"prompt_tokens": tokens, "total_tokens": tokens}})

        for prefix in ("", "/v1"):
            app.add_api_route(f"{prefix}/chat/completions", chat, methods=["POST"])
            app.add_api_route(f"{prefix}/embeddings", embeddings, methods=["POST"])
        return app
