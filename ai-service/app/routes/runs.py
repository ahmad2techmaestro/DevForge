"""Run routes."""

from __future__ import annotations

from fastapi import APIRouter, Request

from app.schemas import ApproveRequest, CommitRequest, CreateRunRequest, PushRequest
from app.types import JsonDict

router = APIRouter()


@router.post("/runs", status_code=202)
async def create_run(body: CreateRunRequest, request: Request) -> JsonDict:
    await request.app.state.runs.start(body)
    return {"runId": body.runId, "status": "running"}


@router.get("/runs/{run_id}")
async def get_run(run_id: str, request: Request) -> JsonDict:
    return await request.app.state.runs.snapshot(run_id)


@router.post("/runs/{run_id}/approve")
async def approve(run_id: str, body: ApproveRequest, request: Request) -> JsonDict:
    await request.app.state.runs.approve(run_id, body)
    return {"ok": True}


@router.post("/runs/{run_id}/cancel")
async def cancel(run_id: str, request: Request) -> JsonDict:
    await request.app.state.runs.cancel(run_id)
    return {"ok": True}


@router.get("/runs/{run_id}/diff")
async def diff(run_id: str, request: Request) -> JsonDict:
    text, files = await request.app.state.runs.diff(run_id)
    return {"diff": text, "files": [f.model_dump() for f in files]}


@router.post("/runs/{run_id}/commit")
async def commit(run_id: str, body: CommitRequest, request: Request) -> JsonDict:
    return await request.app.state.runs.commit(run_id, body)


@router.post("/runs/{run_id}/push")
async def push(run_id: str, body: PushRequest, request: Request) -> JsonDict:
    return await request.app.state.runs.push(run_id, body)
