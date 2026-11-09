"""LLM provider self-check."""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.errors import ApiError
from app.llm.provider import check_provider
from app.types import JsonDict

router = APIRouter()
ROOT = Path(__file__).resolve().parents[2]
TOTAL_TASKS = 14


@router.get("/llm/check")
async def llm_check(request: Request) -> JsonDict:
    """One 1-token call to the configured provider: {ok, provider, model, error?}."""
    return await check_provider(request.app.state.settings)


@router.get("/eval/latest")
async def eval_latest() -> JsonDict:
    """Latest DevForge-Bench result written by eval/run_bench.py (or {available: false})."""
    import json
    from pathlib import Path

    path = Path(__file__).resolve().parents[2] / "eval" / "results" / "latest.json"
    if not path.is_file():
        return {"available": False}
    try:
        return {"available": True, **json.loads(path.read_text(encoding="utf-8"))}
    except (OSError, ValueError):
        return {"available": False}


class BenchRequest(BaseModel):
    limit: int | None = Field(default=None, ge=1, le=TOTAL_TASKS)


def _bench_state(request: Request) -> JsonDict:
    state = getattr(request.app.state, "bench", None)
    if state is None:
        state = {"status": "idle", "done": 0, "total": 0, "current": "", "error": "", "startedAt": None, "finishedAt": None}
        request.app.state.bench = state
    return state  # type: ignore[no-any-return]


async def _run_bench(request: Request, limit: int | None) -> None:
    """Run eval/run_bench.py with this service's provider settings and track its progress."""
    state = _bench_state(request)
    cmd = [sys.executable, str(ROOT / "eval" / "run_bench.py")] + (["--limit", str(limit)] if limit else [])
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, cwd=str(ROOT), stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )  # fmt: skip
        assert proc.stdout is not None
        tail: list[str] = []
        async for raw in proc.stdout:
            line = raw.decode(errors="replace").rstrip()
            tail = (tail + [line])[-12:]
            if line.startswith("[bench] ") and line.endswith(" ..."):
                state["current"] = line[len("[bench] "):-4]
            elif line.startswith("[bench]   ->"):
                state["done"] = int(state["done"]) + 1  # type: ignore[call-overload]
        code = await proc.wait()
        state["status"] = "done" if code == 0 else "error"
        if code != 0:
            state["error"] = "\n".join(tail)[-800:] or f"benchmark exited with code {code}"
    except Exception as exc:  # noqa: BLE001 - surfaced to the UI
        state["status"], state["error"] = "error", str(exc)
    finally:
        state["current"] = ""
        state["finishedAt"] = time.time()


@router.post("/eval/run", status_code=202)
async def eval_run(body: BenchRequest, request: Request) -> JsonDict:
    """Start DevForge-Bench in the background with the configured provider. One run at a time."""
    settings = request.app.state.settings
    state = _bench_state(request)
    if state["status"] == "running":
        raise ApiError(409, "bench_running", "A benchmark is already running")
    if settings.llm_provider == "mock":
        raise ApiError(409, "bench_needs_provider", "Configure a real model first (LLM_PROVIDER and its API key in .env). The offline demo model cannot solve tasks.")
    total = body.limit or TOTAL_TASKS
    state.update(status="running", done=0, total=total, current="", error="", startedAt=time.time(), finishedAt=None)
    request.app.state.bench_task = asyncio.create_task(_run_bench(request, body.limit))
    return dict(state)


@router.get("/eval/status")
async def eval_status(request: Request) -> JsonDict:
    return dict(_bench_state(request))
