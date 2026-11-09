"""The LangGraph run pipeline: classify -> plan -> approve -> implement -> test/fix -> review -> approve -> pr_draft."""

from __future__ import annotations

import asyncio
import re
import shutil
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal, TypedDict

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import interrupt

from app.config import Settings
from app.llm.base import Brain, WorkContext
from app.llm.usage import UsageMeter
from app.repo import gitops
from app.repo.index import RepoIndex, RepoService
from app.repo.risk import score_diff
from app.repo.rules import analyze_file
from app.runs.record import RunRecord
from app.sandbox.base import Sandbox
from app.sandbox.runner import detect, run_tests
from app.schemas import Approval, CreateRunRequest, DiffFile, PlanStep, Risk
from app.security import redact
from app.types import Emit, JsonDict

MAX_REJECTIONS = 3
ANALYSIS_KINDS = ("review", "explain")
PREFIX = {"feature": "feat", "bugfix": "fix", "refactor": "refactor", "tests": "test"}


class RunState(TypedDict, total=False):
    plan: list[JsonDict]
    plan_summary: str
    feedback: str | None
    rejections: int
    fix_attempts: int
    approval_id: str
    decision: str
    tests_ok: bool
    tests_output: str
    tests_counts: list[int]
    diff: str
    files: list[JsonDict]
    risk: JsonDict
    impl_summary: str
    analysis: str
    error: str


@dataclass
class RunDeps:
    rec: RunRecord
    req: CreateRunRequest
    settings: Settings
    brain: Brain
    meter: UsageMeter
    sandbox: Sandbox
    repos: RepoService
    emit: Emit


def _steps(state: RunState) -> list[PlanStep]:
    return [PlanStep(**s) for s in state.get("plan", [])]  # type: ignore[arg-type]


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "change"


def _plan_risk(kind: str, steps: list[PlanStep]) -> Risk:
    if kind in ANALYSIS_KINDS:
        return Risk(score=0, level="low", reasons=["Analysis only; no files will change."])
    files = sorted({f for s in steps for f in s.files})
    return score_diff([DiffFile(path=f, status="modified", additions=15, deletions=0) for f in files])


def build_graph(deps: RunDeps, checkpointer: BaseCheckpointSaver[str]) -> CompiledStateGraph:  # type: ignore[type-arg]
    req, rec, emit = deps.req, deps.rec, deps.emit
    kind = req.task.kind
    analysis = kind in ANALYSIS_KINDS
    last_usage: list[tuple[int, int]] = [(-1, -1)]
    notes = [n.strip()[:300] for n in req.memory if n.strip()]
    # The brief is what the model sees; the PR body keeps the user's original description.
    brief = req.task.description
    if notes:
        brief += "\n\n## Repository memory (follow these conventions and past feedback)\n" + "\n".join(
            f"- {n}" for n in notes
        )

    async def emit_usage() -> None:
        snap = deps.meter.snapshot()
        key = (snap.inputTokens, snap.outputTokens)
        if key != last_usage[0]:
            last_usage[0] = key
            await emit("usage", snap.model_dump())

    def node(name: str, fn: Callable[[RunState], Awaitable[RunState]]) -> Callable[[RunState], Awaitable[RunState]]:
        async def inner(state: RunState) -> RunState:
            await emit("node.started", {"node": name})
            out = await fn(state)
            await emit("node.finished", {"node": name})
            await emit_usage()
            return out

        return inner

    async def workspace_diff() -> tuple[str, list[DiffFile]]:
        return await gitops.working_diff(rec.workspace, rec.base_commit)

    # ---- nodes ------------------------------------------------------------

    async def classify(state: RunState) -> RunState:
        src = deps.repos.path(req.repoId)
        if not src.is_dir():
            raise RuntimeError(f"repository {req.repoId} is not indexed")
        ws = rec.workspace
        if ws.exists():
            await asyncio.to_thread(shutil.rmtree, ws)
        await gitops.git(None, "clone", "--quiet", "--no-hardlinks", "--", str(src), str(ws))
        await gitops.git(ws, "remote", "remove", "origin", check=False)
        exclude = ws / ".git" / "info" / "exclude"
        exclude.parent.mkdir(parents=True, exist_ok=True)
        exclude.write_text(
            "__pycache__/\n*.pyc\n.pytest_cache/\nnode_modules/\n.devforge_deps/\n.coverage\n", "utf-8"
        )
        rec.base_commit = await gitops.head_commit(ws)
        rec.save()
        mode = "analysis-only" if analysis else "code-changing"
        await emit("log", {"level": "info", "message": f"classified as {kind} ({mode}); isolated clone ready"})
        if notes:
            await emit("log", {"level": "info", "message": f"loaded {len(notes)} repository memory note(s)"})
        return {"rejections": 0, "fix_attempts": 0, "feedback": None}

    async def plan(state: RunState) -> RunState:
        index = await deps.repos.get(req.repoId)
        res = await deps.brain.plan(
            index, kind, req.task.title, brief, state.get("feedback"), emit
        )
        risk = _plan_risk(kind, res.steps)
        await emit("plan.proposed", {
            "steps": [s.model_dump() for s in res.steps], "summary": res.summary, "risk": risk.model_dump(),
            "requirements": res.requirements, "design": res.design,
        })  # fmt: skip
        return {"plan": [s.model_dump() for s in res.steps], "plan_summary": res.summary}

    async def plan_request(state: RunState) -> RunState:
        approval = Approval(
            approvalId=uuid.uuid4().hex, kind="plan", summary=state.get("plan_summary", "Plan"),
            payload={"steps": state.get("plan", []), "risk": _plan_risk(kind, _steps(state)).model_dump()},
        )  # fmt: skip
        await emit("approval.requested", approval.model_dump())
        return {"approval_id": approval.approvalId}

    async def resolve(state: RunState, what: Literal["plan", "changes"]) -> RunState:
        approval_id = state["approval_id"]
        if req.options.autoApprove:
            decision: JsonDict = {"decision": "approve", "feedback": "auto-approved"}
        else:
            decision = interrupt({"approvalId": approval_id, "kind": what})  # type: ignore[assignment]
        verdict = str(decision.get("decision", "reject"))
        feedback = decision.get("feedback")
        event: JsonDict = {"approvalId": approval_id, "decision": verdict}
        if feedback:
            event["feedback"] = feedback
        await emit("approval.resolved", event)
        out: RunState = {"decision": verdict}
        if verdict == "approve":
            out["feedback"] = None
            edited = decision.get("editedPlan")
            if what == "plan" and isinstance(edited, list) and edited:
                out["plan"] = [PlanStep(**s).model_dump() for s in edited]  # type: ignore[arg-type]
            if what == "changes":
                rec.changes_approved = True
                rec.save()
        else:
            out["rejections"] = state.get("rejections", 0) + 1
            out["feedback"] = str(feedback) if feedback else "Rejected without feedback; please revise."
            if out["rejections"] >= MAX_REJECTIONS:
                out["error"] = f"{what} was rejected {MAX_REJECTIONS} times; giving up"
        return out

    async def plan_wait(state: RunState) -> RunState:
        return await resolve(state, "plan")

    async def changes_wait(state: RunState) -> RunState:
        return await resolve(state, "changes")

    async def implement(state: RunState) -> RunState:
        ctx = WorkContext(
            workspace=rec.workspace, kind=kind, title=req.task.title, description=brief,
            plan=_steps(state), sandbox=deps.sandbox, emit=emit, feedback=state.get("feedback"),
        )  # fmt: skip
        summary = await deps.brain.implement(ctx)
        diff, files = await workspace_diff()
        if not files:
            await emit("log", {"level": "warn", "message": "implementation produced no file changes"})
        return {"impl_summary": summary, "diff": diff, "files": [f.model_dump() for f in files], "fix_attempts": 0}

    async def test(state: RunState) -> RunState:
        tplan = detect(rec.workspace)
        if tplan is None:
            await emit("tests.result", {
                "passed": 0, "failed": 0, "total": 0, "ok": True, "output": "No test runner detected.",
                "durationMs": 0, "sandbox": deps.sandbox.name, "framework": "none",
            })  # fmt: skip
            return {"tests_ok": True, "tests_output": "", "tests_counts": [0, 0]}
        await emit("tests.started", {"command": tplan.display(), "sandbox": deps.sandbox.name})
        try:
            out = await run_tests(deps.sandbox, rec.workspace, tplan, deps.settings.command_timeout)
            result: JsonDict = {
                "passed": out.passed, "failed": out.failed, "total": out.total, "ok": out.ok,
                "output": redact(out.output), "durationMs": out.duration_ms,
                "sandbox": deps.sandbox.name, "framework": out.framework,
            }  # fmt: skip
        except Exception as exc:  # sandbox failure (e.g. docker daemon gone) is a test failure, not a crash
            result = {
                "passed": 0, "failed": 0, "total": 0, "ok": False, "output": f"sandbox error: {exc}"[:8192],
                "durationMs": 0, "sandbox": deps.sandbox.name, "framework": tplan.framework,
            }  # fmt: skip
        await emit("tests.result", result)
        return {
            "tests_ok": bool(result["ok"]), "tests_output": str(result["output"]),
            "tests_counts": [int(result["passed"]), int(result["failed"])],  # type: ignore[call-overload]
        }  # fmt: skip

    async def fix(state: RunState) -> RunState:
        attempt = state.get("fix_attempts", 0) + 1
        await emit("log", {"level": "info", "message": f"fix attempt {attempt}/{req.options.maxFixAttempts}"})
        ctx = WorkContext(
            workspace=rec.workspace, kind=kind, title=req.task.title, description=brief,
            plan=_steps(state), sandbox=deps.sandbox, emit=emit, test_output=state.get("tests_output", ""),
        )  # fmt: skip
        await deps.brain.implement(ctx)
        diff, files = await workspace_diff()
        return {"fix_attempts": attempt, "diff": diff, "files": [f.model_dump() for f in files]}

    async def review(state: RunState) -> RunState:
        index = await deps.repos.get(req.repoId)
        if analysis:
            text = await deps.brain.analyze(index, kind, req.task.title, brief, emit)
            comments: list[JsonDict] = []
            if kind == "review":
                for p in sorted({f for s in _steps(state) for f in s.files})[:10]:
                    info = index.by_path(p)
                    for f in analyze_file(p, info.language, index.texts[p]) if info else []:
                        sev = "high" if f.severity == "critical" else f.severity
                        comments.append({"path": f.path, "line": f.line, "severity": sev, "body": f"{f.title}. {f.detail}"})
            risk = Risk(score=0, level="low", reasons=["Analysis only."])
            await emit("review.result", {"summary": text, "risk": risk.model_dump(), "comments": comments})
            return {"analysis": text, "risk": risk.model_dump()}
        diff, files = await workspace_diff()
        risk = score_diff(files)
        ws_index = await asyncio.to_thread(RepoIndex.from_dir, rec.workspace)
        result = await deps.brain.review(diff, ws_index)
        comments_m = list(result.comments)
        secrets = [c for c in comments_m if c.body.startswith("Possible hardcoded secret")]
        if secrets:
            risk = Risk(score=min(risk.score + 30, 100), level="high",
                        reasons=[*risk.reasons, "Possible credentials added in this diff."])  # fmt: skip
        if not state.get("tests_ok", True):
            from app.schemas import ReviewComment

            comments_m.append(ReviewComment(path=".", line=1, severity="high", body="Tests are failing after the fix attempts."))
        await emit("diff.ready", {"files": [f.model_dump() for f in files], "risk": risk.model_dump()})
        await emit("review.result", {
            "summary": result.summary, "risk": risk.model_dump(), "comments": [c.model_dump() for c in comments_m],
        })  # fmt: skip
        return {"diff": diff, "files": [f.model_dump() for f in files], "risk": risk.model_dump()}

    async def changes_request(state: RunState) -> RunState:
        passed, failed = state.get("tests_counts", [0, 0])
        approval = Approval(
            approvalId=uuid.uuid4().hex, kind="changes",
            summary=f"{len(state.get('files', []))} file(s) changed; tests {'passing' if state.get('tests_ok', True) else 'FAILING'}",
            payload={"files": state.get("files", []), "risk": state.get("risk", {}),
                     "tests": {"passed": passed, "failed": failed, "ok": state.get("tests_ok", True)}},
        )  # fmt: skip
        await emit("approval.requested", approval.model_dump())
        return {"approval_id": approval.approvalId}

    async def pr_draft(state: RunState) -> RunState:
        files = state.get("files", [])
        risk = state.get("risk", {})
        passed, failed = state.get("tests_counts", [0, 0])
        steps = _steps(state)
        title = f"{PREFIX.get(kind, 'chore')}: {req.task.title}"[:120]
        body = "\n".join([
            "## Summary", "", req.task.description or req.task.title, "",
            "## Changes", "", *[f"- `{f['path']}` ({f['status']}, +{f['additions']}/-{f['deletions']})" for f in files], "",
            "## Plan", "", *[f"{i}. {s.title}" for i, s in enumerate(steps, 1)], "",
            "## Verification", "", f"- Tests: {passed} passed, {failed} failed", f"- Risk: {risk.get('level', 'n/a')} ({risk.get('score', 0)}/100)", "",
            "_Prepared by DevForge; approved by a human before this draft was created._",
        ])  # fmt: skip
        branch = f"devforge/{kind}-{_slug(req.task.title)}-{rec.run_id[:8]}"
        await emit("pr.draft", {"title": title, "body": body, "branch": branch})
        return {}

    async def done(state: RunState) -> RunState:
        await emit_usage()
        if analysis:
            summary = state.get("analysis", "Analysis complete.").splitlines()[0][:300]
        else:
            n = len(state.get("files", []))
            passed, failed = state.get("tests_counts", [0, 0])
            summary = f"{state.get('impl_summary', 'Changes ready')[:200]} {n} file(s) changed; tests: {passed} passed, {failed} failed."
        await emit("run.completed", {"status": "completed", "summary": summary})
        return {}

    async def fail(state: RunState) -> RunState:
        await emit("run.failed", {"error": state.get("error", "run failed")})
        return {}

    # ---- routing ----------------------------------------------------------

    def after_plan(state: RunState) -> str:
        if state.get("decision") == "reject":
            return "fail" if state.get("error") else "plan"
        return "review" if analysis else "implement"

    def after_tests(state: RunState) -> str:
        if not state.get("tests_ok", True) and state.get("fix_attempts", 0) < req.options.maxFixAttempts:
            return "fix"
        return "review"

    def after_review(_: RunState) -> str:
        return "done" if analysis else "changes_request"

    def after_changes(state: RunState) -> str:
        if state.get("decision") == "reject":
            return "fail" if state.get("error") else "implement"
        return "pr_draft"

    g: StateGraph = StateGraph(RunState)  # type: ignore[type-arg]
    for name, fn in [("classify", classify), ("plan", plan), ("implement", implement), ("test", test),
                     ("fix", fix), ("review", review), ("pr_draft", pr_draft)]:  # fmt: skip
        g.add_node(name, node(name, fn))
    for name, fn in [("plan_request", plan_request), ("plan_wait", plan_wait), ("changes_request", changes_request),
                     ("changes_wait", changes_wait), ("done", done), ("fail", fail)]:  # fmt: skip
        g.add_node(name, fn)
    g.add_edge(START, "classify")
    g.add_edge("classify", "plan")
    g.add_edge("plan", "plan_request")
    g.add_edge("plan_request", "plan_wait")
    g.add_conditional_edges("plan_wait", after_plan, ["plan", "implement", "review", "fail"])
    g.add_edge("implement", "test")
    g.add_conditional_edges("test", after_tests, ["fix", "review"])
    g.add_edge("fix", "test")
    g.add_conditional_edges("review", after_review, ["done", "changes_request"])
    g.add_edge("changes_request", "changes_wait")
    g.add_conditional_edges("changes_wait", after_changes, ["implement", "pr_draft", "fail"])
    g.add_edge("pr_draft", "done")
    g.add_edge("done", END)
    g.add_edge("fail", END)
    return g.compile(checkpointer=checkpointer)


__all__ = ["RunDeps", "build_graph"]
