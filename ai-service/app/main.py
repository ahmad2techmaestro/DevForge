"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import Depends, FastAPI, Request
from langgraph.checkpoint.memory import MemorySaver

from app import __version__
from app.auth import require_key
from app.config import Settings
from app.errors import install_error_handlers
from app.llm.provider import BrainFactory, default_brain_factory
from app.repo.index import RepoService
from app.routes import intel as intel_routes
from app.routes import llm as llm_routes
from app.routes import mcp as mcp_routes
from app.routes import repos as repo_routes
from app.routes import review as review_routes
from app.routes import runs as run_routes
from app.runs.manager import RunManager
from app.sandbox.base import Sandbox
from app.sandbox.docker_sandbox import DockerSandbox, docker_available
from app.sandbox.subprocess_sandbox import SubprocessSandbox
from app.types import JsonDict

_DOCKER_TTL = 30.0


async def resolve_sandbox(settings: Settings, available: bool) -> Sandbox:
    docker = DockerSandbox(settings.docker_python_image, settings.docker_node_image)
    if settings.sandbox == "docker" or (settings.sandbox == "auto" and available):
        return docker
    return SubprocessSandbox()


def create_app(
    settings: Settings | None = None,
    *,
    brain_factory: BrainFactory | None = None,
    sandbox: Sandbox | None = None,
    allow_local_push: bool | None = None,
) -> FastAPI:
    cfg = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        cfg.workdir.mkdir(parents=True, exist_ok=True)
        app.state.docker_cache = (0.0, False)
        available = await _docker_cached(app)
        app.state.sandbox = sandbox or await resolve_sandbox(cfg, available)
        client = httpx.AsyncClient()
        saver_cm = None
        try:
            from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

            saver_cm = AsyncSqliteSaver.from_conn_string(str(cfg.workdir / "checkpoints.sqlite"))
            saver = await saver_cm.__aenter__()
        except Exception:  # sqlite checkpointer unavailable: fall back to memory
            saver_cm, saver = None, MemorySaver()  # type: ignore[assignment]
        app.state.runs = RunManager(
            cfg, app.state.repos, app.state.brain_factory, app.state.sandbox, client, saver,
            allow_local_push=bool(allow_local_push) or os.environ.get("ALLOW_LOCAL_PUSH") == "true",
        )  # fmt: skip
        try:
            yield
        finally:
            await app.state.runs.shutdown()
            await client.aclose()
            if saver_cm is not None:
                await saver_cm.__aexit__(None, None, None)

    app = FastAPI(title="DevForge agent", version=__version__, lifespan=lifespan)
    app.state.settings = cfg
    app.state.repos = RepoService(cfg.repos_dir)
    app.state.brain_factory = brain_factory or default_brain_factory(cfg)
    app.state.started = time.monotonic()
    install_error_handlers(app)

    @app.get("/health")
    async def health(request: Request) -> JsonDict:
        available = await _docker_cached(request.app, wait=False)
        return {
            "status": "ok", "provider": cfg.llm_provider, "model": cfg.model,
            "sandbox": request.app.state.sandbox.name, "dockerAvailable": available, "version": __version__,
        }  # fmt: skip

    app.include_router(repo_routes.router, dependencies=[Depends(require_key)])
    app.include_router(run_routes.router, dependencies=[Depends(require_key)])
    app.include_router(intel_routes.router, dependencies=[Depends(require_key)])
    app.include_router(review_routes.router, dependencies=[Depends(require_key)])
    app.include_router(llm_routes.router, dependencies=[Depends(require_key)])
    app.include_router(mcp_routes.router, dependencies=[Depends(require_key)])
    return app


async def _docker_cached(app: FastAPI, *, wait: bool = True) -> bool:
    """Docker availability, cached. With wait=False a stale value is returned at once and refreshed in the background."""
    ts, value = app.state.docker_cache
    if time.monotonic() - ts > _DOCKER_TTL:
        if wait:
            value = await docker_available()
            app.state.docker_cache = (time.monotonic(), value)
        elif getattr(app.state, "docker_refresh", None) is None or app.state.docker_refresh.done():
            async def refresh() -> None:
                app.state.docker_cache = (time.monotonic(), await docker_available())

            app.state.docker_refresh = asyncio.create_task(refresh())
    return bool(value)


app = create_app()
