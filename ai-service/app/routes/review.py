"""PR review (`POST /reviews/pr`) and CI-failure analysis (`POST /ci/analyze`)."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.errors import ApiError, bad_request
from app.llm.usage import UsageMeter
from app.repo.cilog import analyze_log, build_summary, strip_noise, suggest_task
from app.repo.diffparse import (
    diff_stats,
    map_comment_line,
    parse_unified_diff,
    resolve_file,
    truncate_diff,
)
from app.repo.index import RepoIndex
from app.repo.risk import parse_diff, score_diff
from app.repo.rules import analyze_file
from app.repo.search import BM25Index
from app.schemas import ChatMessage
from app.types import JsonDict

router = APIRouter()

MAX_DIFF_CHARS = 5_000_000
MAX_LOG_CHARS = 5_000_000
MAX_COMMENTS = 60
_SEV_RANK = {"info": 0, "low": 1, "medium": 2, "high": 3}


class PrReviewRequest(BaseModel):
    title: str | None = Field(default=None, max_length=500)
    description: str | None = Field(default=None, max_length=20_000)
    diff: str = Field(min_length=1, max_length=MAX_DIFF_CHARS)
    repoId: str | None = None
    baseRef: str | None = Field(default=None, max_length=200)
    headRef: str | None = Field(default=None, max_length=200)


class CiAnalyzeRequest(BaseModel):
    log: str = Field(min_length=1, max_length=MAX_LOG_CHARS)
    workflow: str | None = Field(default=None, max_length=200)
    jobName: str | None = Field(default=None, max_length=200)


async def _maybe_index(request: Request, repo_id: str | None) -> RepoIndex | None:
    if not repo_id:
        return None
    try:
        return await request.app.state.repos.get(repo_id)
    except ApiError:
        return None  # an unindexed repo must not block a review


@router.post("/reviews/pr")
async def review_pr(body: PrReviewRequest, request: Request) -> JsonDict:
    files = parse_unified_diff(body.diff)
    reviewable = [f for f in files if not f.binary]
    if not reviewable:
        raise bad_request("empty_diff", "the diff contains no reviewable changes")
    settings = request.app.state.settings
    meter = UsageMeter(settings.model)
    brain = request.app.state.brain_factory(meter)
    text, cut = truncate_diff(body.diff)
    # The mock brain would run static rules against the base checkout, whose line numbers do not match the PR.
    index = await _maybe_index(request, body.repoId) if settings.llm_provider != "mock" else None
    result = await brain.review(text, index)

    # Static rules run on the added lines of the complete diff (not the truncated one).
    raw: list[dict[str, object]] = []
    for f in reviewable:
        added = f.added_lines()
        if not added or f.status == "deleted":
            continue
        top = max(added)
        content = "\n".join(added.get(i, "") for i in range(1, top + 1))
        lang = _lang(f.path)
        for fnd in analyze_file(f.path, lang, content):
            if fnd.line in added:
                sev = "high" if fnd.severity == "critical" else fnd.severity
                raw.append({
                    "path": f.path, "line": fnd.line, "severity": sev, "body": f"{fnd.title}. {fnd.detail}",
                    "suggestion": fnd.suggestion,
                })  # fmt: skip
    raw += [
        {"path": c.path, "line": c.line, "severity": c.severity, "body": c.body,
         "suggestion": getattr(c, "suggestion", None)}
        for c in result.comments
    ]  # fmt: skip

    comments: list[JsonDict] = []
    seen: set[tuple[str, int, str]] = set()
    dropped = relocated = 0
    for c in raw:
        f = resolve_file(files, str(c["path"]))
        line = int(c["line"])  # type: ignore[call-overload]
        mapped = map_comment_line(f, line) if f else None
        if f is None or mapped is None:
            dropped += 1
            continue
        relocated += mapped != line
        key = (f.path, mapped, str(c["body"])[:60])
        if key in seen:
            continue
        seen.add(key)
        sev = str(c["severity"]) if str(c["severity"]) in _SEV_RANK else "low"
        item: JsonDict = {"path": f.path, "line": mapped, "side": "RIGHT", "severity": sev, "body": str(c["body"])}
        if c.get("suggestion"):
            item["suggestion"] = str(c["suggestion"])
        comments.append(item)
    comments.sort(key=lambda x: (-_SEV_RANK[str(x["severity"])], str(x["path"]), int(x["line"])))  # type: ignore[call-overload]
    comments = comments[:MAX_COMMENTS]

    risk = score_diff(parse_diff(body.diff))
    secrets = any(str(c["body"]).startswith("Possible hardcoded secret") for c in comments)
    risk_level = "high" if secrets else risk.level
    top_sev = max((_SEV_RANK[str(c["severity"])] for c in comments), default=-1)
    if top_sev >= _SEV_RANK["high"] or secrets:
        verdict = "request_changes"
    elif comments and top_sev >= _SEV_RANK["low"] or risk_level != "low":
        verdict = "comment"
    else:
        verdict = "approve"
    stats = diff_stats(files)
    head = f"PR “{body.title}”: " if body.title else ""
    summary = f"{head}{result.summary}".strip()
    if cut:
        summary += f" Large diff: {len(cut)} file(s) were truncated for the model ({', '.join(cut[:5])})."
    out: JsonDict = {
        "summary": summary, "verdict": verdict, "riskScore": risk_level, "comments": comments,
        "stats": {**stats, "droppedComments": dropped, "relocatedComments": relocated, "truncatedFiles": len(cut)},
        "risk": risk.model_dump(), "usage": meter.snapshot().model_dump(),
    }  # fmt: skip
    return out


def _lang(path: str) -> str:
    from app.repo.files import detect_language

    return detect_language(path)


@router.post("/ci/analyze")
async def ci_analyze(body: CiAnalyzeRequest, request: Request) -> JsonDict:
    analysis = analyze_log(body.log)
    summary = build_summary(analysis, body.workflow, body.jobName)
    settings = request.app.state.settings
    meter = UsageMeter(settings.model)
    if settings.llm_provider != "mock":
        refined = await _refine_summary(request, meter, analysis, summary, strip_noise(body.log))
        if refined:
            summary = refined
    kind: Literal["test", "lint", "build", "install", "other"] = analysis.kind  # type: ignore[assignment]
    return {
        "summary": summary, "failureKind": kind, "failingTests": analysis.failing_tests,
        "errorLines": analysis.error_lines, "suspectedFiles": analysis.files,
        "suggestedTask": suggest_task(analysis, body.jobName), "usage": meter.snapshot().model_dump(),
    }  # fmt: skip


async def _refine_summary(request: Request, meter: UsageMeter, a: object, summary: str, text: str) -> str | None:
    """Ask the configured model to rewrite the deterministic summary; any failure keeps the original."""
    tail = text[-6000:]
    prompt = (
        "A CI job failed. Using the parsed facts and the log tail below, write a 2-3 sentence plain-text "
        "diagnosis: what failed and the most likely cause. Do not invent file names.\n\n"
        f"Parsed summary: {summary}\n\nLog tail:\n{tail}"
    )
    try:
        brain = request.app.state.brain_factory(meter)
        empty = RepoIndex(Path("."), [], {}, BM25Index({}))
        res = await brain.chat(empty, [ChatMessage(role="user", content=prompt)])
    except Exception:
        return None
    answer = res.answer.strip()
    return answer[:1200] if answer else None
