"""Code-intelligence routes (all under the shared API key).

GET /repos/{id}/semantic-search?q=&mode=hybrid|bm25|semantic&limit=
    -> {mode, embedder, results:[{path,line,endLine,score,snippet,symbol}]}
GET /repos/{id}/symbols?path=            -> {engine, symbols:[{name,kind,path,line,endLine,complexity?}]}
GET /repos/{id}/impact?path=&symbol=     -> {engine,target,exists,direct,transitive,tests,symbolCallers,risk,summary}
GET /repos/{id}/callgraph?path=          -> {engine,nodes:[{id,path,symbol}],edges:[{from,to}],truncated}
"""

from __future__ import annotations

import asyncio
from typing import Literal

from fastapi import APIRouter, Query, Request

from app.errors import bad_request
from app.llm.provider import ChatModelBrain
from app.repo.embeddings import build_embedder
from app.types import JsonDict

router = APIRouter()


@router.get("/repos/{repo_id}/semantic-search")
async def semantic_search(
    repo_id: str, request: Request, q: str = Query(min_length=1, max_length=500),
    mode: Literal["hybrid", "bm25", "semantic"] = "hybrid", limit: int = Query(10, ge=1, le=50),
    rerank: bool = False,
) -> JsonDict:
    idx = await request.app.state.repos.get(repo_id)
    embedder = build_embedder(request.app.state.settings)
    cache = request.app.state.repos.path(repo_id).parent / f"{repo_id}.vectors.sqlite"
    sem = idx.semantic(embedder, cache)
    if not rerank or mode == "bm25":
        return await sem.search(q, mode, limit)
    from app.llm.provider import build_reranker
    from app.llm.usage import UsageMeter
    from app.repo.rerank import apply_rerank

    settings = request.app.state.settings
    brain = request.app.state.brain_factory(UsageMeter(settings.model))
    res = await sem.search(q, mode, max(limit * 3, 20))
    res["results"], res["reranker"] = await apply_rerank(  # type: ignore[arg-type]
        build_reranker(settings, brain if isinstance(brain, ChatModelBrain) else None), q, res["results"], limit)
    return res


@router.get("/repos/{repo_id}/symbols")
async def symbols(repo_id: str, request: Request, path: str | None = None) -> JsonDict:
    idx = await request.app.state.repos.get(repo_id)
    intel = await asyncio.to_thread(idx.intel)
    if path and path not in intel.files:
        raise bad_request("unsupported_file", "no symbols for that file (unsupported language or not found)")
    return {"engine": intel.engine, "symbols": intel.symbols(path)}


@router.get("/repos/{repo_id}/impact")
async def impact(repo_id: str, request: Request, path: str, symbol: str | None = None) -> JsonDict:
    idx = await request.app.state.repos.get(repo_id)
    if idx.by_path(path) is None:
        raise bad_request("file_not_found", f"file not found: {path}")
    intel = await asyncio.to_thread(idx.intel)
    return intel.impact(path, symbol)


@router.get("/repos/{repo_id}/callgraph")
async def callgraph(repo_id: str, request: Request, path: str | None = None) -> JsonDict:
    idx = await request.app.state.repos.get(repo_id)
    intel = await asyncio.to_thread(idx.intel)
    return intel.callgraph(path)
