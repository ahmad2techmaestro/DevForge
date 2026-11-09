"""Repository intelligence routes."""

from __future__ import annotations

from fastapi import APIRouter, Request

from app.errors import bad_request
from app.llm.usage import UsageMeter
from app.repo.risk import parse_diff, score_diff
from app.repo.rules import analyze_file
from app.repo.security_audit import audit_with_engines
from app.schemas import (
    BugsRequest,
    ChatRequest,
    ExplainRequest,
    Finding,
    IndexRequest,
    ReviewRequest,
    SearchRequest,
)
from app.types import JsonDict

router = APIRouter()


@router.post("/repos/index")
async def index_repo(body: IndexRequest, request: Request) -> JsonDict:
    return await request.app.state.repos.index(body)


@router.delete("/repos/{repo_id}")
async def delete_repo(repo_id: str, request: Request) -> JsonDict:
    request.app.state.repos.delete(repo_id)
    return {"deleted": True}


@router.get("/repos/{repo_id}/tree")
async def tree(repo_id: str, request: Request) -> JsonDict:
    idx = await request.app.state.repos.get(repo_id)
    return {"files": [{"path": f.path, "size": f.size, "language": f.language, "lines": f.lines} for f in idx.files]}


@router.get("/repos/{repo_id}/file")
async def file(repo_id: str, path: str, request: Request) -> JsonDict:
    idx = await request.app.state.repos.get(repo_id)
    info, content, truncated = idx.read(path)
    return {"path": info.path, "content": content, "language": info.language, "lines": info.lines, "truncated": truncated}


@router.post("/repos/{repo_id}/search")
async def search(repo_id: str, body: SearchRequest, request: Request) -> JsonDict:
    idx = await request.app.state.repos.get(repo_id)
    hits = idx.bm25.search(body.query, body.limit)
    return {"results": [{"path": h.path, "line": h.line, "snippet": h.snippet, "score": h.score} for h in hits]}


@router.post("/repos/{repo_id}/explain")
async def explain(repo_id: str, body: ExplainRequest, request: Request) -> JsonDict:
    idx = await request.app.state.repos.get(repo_id)
    meter = UsageMeter(request.app.state.settings.model)
    text = await request.app.state.brain_factory(meter).explain(idx, body.path, body.question)
    return {"explanation": text, "usage": meter.snapshot().model_dump()}


@router.post("/repos/{repo_id}/chat")
async def chat(repo_id: str, body: ChatRequest, request: Request) -> JsonDict:
    idx = await request.app.state.repos.get(repo_id)
    meter = UsageMeter(request.app.state.settings.model)
    res = await request.app.state.brain_factory(meter).chat(idx, body.messages)
    return {"answer": res.answer, "citations": res.citations, "usage": meter.snapshot().model_dump()}


@router.get("/repos/{repo_id}/health")
async def health(repo_id: str, request: Request) -> JsonDict:
    idx = await request.app.state.repos.get(repo_id)
    return idx.health()


@router.get("/repos/{repo_id}/graph")
async def graph(repo_id: str, request: Request) -> JsonDict:
    idx = await request.app.state.repos.get(repo_id)
    return dict(idx.graph())


@router.post("/repos/{repo_id}/bugs")
async def bugs(repo_id: str, body: BugsRequest, request: Request) -> JsonDict:
    idx = await request.app.state.repos.get(repo_id)
    paths = body.paths or [f.path for f in idx.files]
    findings: list[Finding] = []
    for p in paths:
        info = idx.by_path(p)
        if info is None:
            raise bad_request("invalid_path", f"unknown file: {p}")
        findings += analyze_file(p, info.language, idx.texts[p])
    meter = UsageMeter(request.app.state.settings.model)
    if request.app.state.settings.llm_provider != "mock":
        findings += await request.app.state.brain_factory(meter).find_bugs(idx, body.paths or [])
    return {"findings": [f.model_dump(exclude_none=True) for f in findings[:500]], "usage": meter.snapshot().model_dump()}


@router.post("/repos/{repo_id}/review")
async def review(repo_id: str, body: ReviewRequest, request: Request) -> JsonDict:
    idx = await request.app.state.repos.get(repo_id)
    meter = UsageMeter(request.app.state.settings.model)
    res = await request.app.state.brain_factory(meter).review(body.diff, idx)
    risk = score_diff(parse_diff(body.diff))
    return {
        "summary": res.summary, "risk": risk.model_dump(),
        "comments": [c.model_dump() for c in res.comments], "usage": meter.snapshot().model_dump(),
    }  # fmt: skip


@router.post("/repos/{repo_id}/security")
async def security(repo_id: str, request: Request) -> JsonDict:
    """Security Auditor: deterministic scan plus an optional LLM-written summary."""
    idx = await request.app.state.repos.get(repo_id)
    report = await audit_with_engines(idx, request.app.state.settings.osv_url)
    out = report.to_json()
    meter = UsageMeter(request.app.state.settings.model)
    top = [f for f in report.findings if f.severity in ("critical", "high")][:15]
    if request.app.state.settings.llm_provider != "mock" and top:
        brief = "\n".join(f"- [{f.severity}] {f.title} at {f.path}:{f.line}" for f in top)
        out["summary"] = await request.app.state.brain_factory(meter).explain(
            idx, top[0].path, "Summarise the security posture and the order to fix these issues:\n" + brief
        )
    else:
        c = report.counts
        out["summary"] = (
            f"{len(report.findings)} finding(s): {c.get('critical', 0)} critical, {c.get('high', 0)} high, "
            f"{c.get('medium', 0)} medium, {c.get('low', 0)} low. Fix critical and high items first."
        )
        if report.tools.get("osv") in ("unreachable", "skipped"):
            out["summary"] += f" osv: {report.tools['osv']} (dependency vulnerabilities were not checked)."
    out["usage"] = meter.snapshot().model_dump()
    return out
