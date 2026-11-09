"""Run lifecycle: start, drive the graph through interrupts, approve, cancel, resync, commit, push."""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Callable
from pathlib import Path
from urllib.parse import urlparse

import httpx
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.types import Command

from app.config import Settings
from app.errors import ApiError, bad_request, conflict, not_found
from app.llm.base import Brain
from app.llm.usage import UsageMeter
from app.mcp.client import CURRENT_TOOLBOX, McpPolicy, McpToolbox
from app.repo import gitops
from app.repo.index import RepoService
from app.repo.risk import added_lines
from app.repo.rules import analyze_secrets
from app.runs.events import EventLog
from app.runs.graph import RunDeps, build_graph
from app.runs.record import TERMINAL, RunRecord
from app.sandbox.base import Sandbox
from app.schemas import (
    Approval,
    ApproveRequest,
    CommitRequest,
    CreateRunRequest,
    DiffFile,
    PushRequest,
)
from app.security import redact
from app.types import JsonDict, valid_id

log = logging.getLogger("devforge.runs")
_BRANCH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")


class RunManager:
    def __init__(
        self,
        settings: Settings,
        repos: RepoService,
        brain_factory: Callable[[UsageMeter], Brain],
        sandbox: Sandbox,
        client: httpx.AsyncClient,
        checkpointer: BaseCheckpointSaver[str],  # type: ignore[type-arg]
        allow_local_push: bool = False,
    ) -> None:
        self.settings = settings
        self.repos = repos
        self.brain_factory = brain_factory
        self.sandbox = sandbox
        self.client = client
        self.checkpointer = checkpointer
        self.allow_local_push = allow_local_push
        self._runs: dict[str, RunRecord] = {}

    # ---- lookup -----------------------------------------------------------

    def _dir(self, run_id: str) -> Path:
        return self.settings.runs_dir / valid_id(run_id, "runId")

    async def _get(self, run_id: str) -> RunRecord:
        if run_id in self._runs:
            return self._runs[run_id]
        d = self._dir(run_id)
        events = EventLog.load(d / "events.jsonl")
        if not events:
            raise not_found("run_not_found", f"run {run_id} not found")
        rec = RunRecord(run_id=run_id, dir=d)
        rec.load_meta()
        types = [str(e["type"]) for e in events]
        terminal = next((t.split(".")[1] for t in reversed(types) if t in ("run.completed", "run.failed", "run.cancelled")), None)
        rec.status = terminal or "running"
        if terminal is None:  # process died mid-run: the graph context is gone, so close it out
            rec.status = "failed"
            rec.log = EventLog(d / "events.jsonl", "http://invalid.local/", self.settings.internal_key, self.client, retries=1)
            rec.log.events = events
            await rec.log.emit("run.failed", {"error": "agent restarted while the run was in progress"})
            rec.save()
        self._runs[run_id] = rec
        return rec

    def _events(self, rec: RunRecord) -> list[JsonDict]:
        return rec.log.events if rec.log else EventLog.load(rec.dir / "events.jsonl")

    # ---- start ------------------------------------------------------------

    async def start(self, req: CreateRunRequest) -> None:
        valid_id(req.runId, "runId")
        valid_id(req.repoId, "repoId")
        if req.runId in self._runs or (self._dir(req.runId) / "events.jsonl").exists():
            raise conflict("run_exists", f"run {req.runId} already exists")
        await self.repos.get(req.repoId)  # 404 early if not indexed
        rec = RunRecord(run_id=req.runId, dir=self._dir(req.runId), req=req)
        rec.dir.mkdir(parents=True, exist_ok=True)
        rec.log = EventLog(
            rec.dir / "events.jsonl", req.callbackUrl, self.settings.internal_key, self.client,
            retries=self.settings.callback_retries, backoff=self.settings.callback_backoff,
        )  # fmt: skip
        self._runs[req.runId] = rec
        rec.task = asyncio.create_task(self._drive(rec, req))

    async def _emit(self, rec: RunRecord, type_: str, data: JsonDict) -> None:
        assert rec.log is not None
        if type_ == "approval.requested":
            rec.pending = Approval(**data)  # type: ignore[arg-type]
            rec.status = "awaiting_approval"
        elif type_ == "approval.resolved":
            rec.pending = None
            rec.status = "running"
        elif type_ == "run.started":
            rec.status = "running"
        elif type_ in ("run.completed", "run.failed", "run.cancelled"):
            rec.status = type_.split(".")[1]
            rec.pending = None
        await rec.log.emit(type_, data)
        if rec.status in TERMINAL:
            rec.save()

    async def _drive(self, rec: RunRecord, req: CreateRunRequest) -> None:
        async def emit(type_: str, data: JsonDict) -> None:
            await self._emit(rec, type_, data)

        meter = UsageMeter(self.settings.model)
        toolbox: McpToolbox | None = None
        try:
            brain = self.brain_factory(meter)
            await emit("run.started", {
                "kind": req.task.kind, "title": req.task.title, "provider": self.settings.llm_provider,
                "model": self.settings.model, "sandbox": self.sandbox.name,
            })  # fmt: skip
            if req.mcpServers:
                toolbox = await McpToolbox.open(req.mcpServers, McpPolicy(
                    allow_stdio=self.settings.mcp_allow_stdio, allow_private_http=self.settings.mcp_allow_private))
                CURRENT_TOOLBOX.set(toolbox)
                for srv, why in toolbox.errors.items():
                    await emit("log", {"level": "warn", "message": f"MCP server '{srv}' unavailable: {why}"})
                if toolbox.clients:
                    await emit("log", {"level": "info", "message": "MCP tools ready: " + ", ".join(sorted(toolbox.clients))})
            deps = RunDeps(rec, req, self.settings, brain, meter, self.sandbox, self.repos, emit)
            graph = build_graph(deps, self.checkpointer)
            cfg = {"configurable": {"thread_id": req.runId}, "recursion_limit": 120}
            graph_input: dict[str, object] | Command[object] | None = {}
            while True:
                await graph.ainvoke(graph_input, cfg)
                state = await graph.aget_state(cfg)
                if not state.next:
                    break
                graph_input = Command(resume=await rec.decisions.get())
        except asyncio.CancelledError:
            if rec.status not in TERMINAL:
                await emit("run.cancelled", {})
        except Exception as exc:
            log.exception("run %s failed", req.runId)
            await emit("run.failed", {"error": redact(f"{type(exc).__name__}: {exc}")[:1000]})
        finally:
            if toolbox:
                await toolbox.close()
            rec.save()
            if rec.log:
                await rec.log.close()

    # ---- control ----------------------------------------------------------

    async def snapshot(self, run_id: str) -> JsonDict:
        rec = await self._get(run_id)
        out: JsonDict = {"runId": run_id, "status": rec.status, "events": self._events(rec)}
        if rec.pending:
            out["pendingApproval"] = rec.pending.model_dump()
        return out

    async def approve(self, run_id: str, body: ApproveRequest) -> None:
        rec = await self._get(run_id)
        if rec.pending is None:
            raise conflict("no_pending_approval", "run is not waiting for approval")
        if rec.pending.approvalId != body.approvalId:
            raise conflict("approval_mismatch", "approvalId does not match the pending approval")
        rec.pending = None
        rec.status = "running"
        payload: dict[str, object] = {"decision": body.decision, "feedback": body.feedback}
        if body.editedPlan is not None:
            payload["editedPlan"] = [s.model_dump() for s in body.editedPlan]
        rec.decisions.put_nowait(payload)

    async def cancel(self, run_id: str) -> None:
        rec = await self._get(run_id)
        if rec.status in TERMINAL or rec.task is None:
            return
        rec.task.cancel()
        await asyncio.gather(rec.task, return_exceptions=True)

    async def shutdown(self) -> None:
        for rec in list(self._runs.values()):
            if rec.task and not rec.task.done():
                rec.task.cancel()
                await asyncio.gather(rec.task, return_exceptions=True)

    # ---- diff / commit / push --------------------------------------------

    async def diff(self, run_id: str) -> tuple[str, list[DiffFile]]:
        rec = await self._get(run_id)
        if not rec.workspace.is_dir() or not rec.base_commit:
            raise conflict("workspace_not_ready", "run workspace is not ready yet")
        return await gitops.working_diff(rec.workspace, rec.base_commit)

    async def commit(self, run_id: str, body: CommitRequest) -> JsonDict:
        rec = await self._get(run_id)
        if not rec.changes_approved:
            raise conflict("not_approved", "changes have not been approved for this run")
        if not _BRANCH.match(body.branch) or ".." in body.branch or body.branch.endswith((".lock", "/")):
            raise bad_request("invalid_branch", "invalid branch name")
        diff, _ = await self.diff(run_id)
        leaked = [f"{p}:{ln}" for p, lines in added_lines(diff).items() for ln, t in lines.items() if analyze_secrets(p, t)]
        if leaked:
            raise ApiError(422, "secrets_detected", f"refusing to commit possible secrets at {', '.join(leaked[:5])}")
        name = body.authorName or "DevForge"
        email = body.authorEmail or "devforge@users.noreply.github.com"
        commit = await gitops.commit_all(rec.workspace, body.message, name, email, body.branch)
        numstat = await gitops.git(rec.workspace, "diff", "--numstat", rec.base_commit, commit)
        names = await gitops.git(rec.workspace, "diff", "--name-status", rec.base_commit, commit)
        rec.committed_branch = body.branch
        rec.save()
        return {"branch": body.branch, "commit": commit,
                "files": [f.model_dump() for f in gitops.parse_numstat(numstat, names)]}  # fmt: skip

    async def push(self, run_id: str, body: PushRequest) -> JsonDict:
        rec = await self._get(run_id)
        if rec.committed_branch is None or rec.committed_branch != body.branch:
            raise conflict("not_committed", "commit the approved changes on this branch first")
        parsed = urlparse(body.cloneUrl)
        local = parsed.scheme == "" and self.allow_local_push
        if not local and parsed.scheme not in ("https", "http"):
            raise bad_request("invalid_clone_url", "cloneUrl must be http(s)")
        if parsed.username or parsed.password:
            raise bad_request("invalid_clone_url", "cloneUrl must not embed credentials")
        await gitops.git(
            rec.workspace, "push", "--", body.cloneUrl, f"refs/heads/{body.branch}:refs/heads/{body.branch}",
            token=None if local else body.token,
        )  # fmt: skip
        return {"pushed": True, "branch": body.branch}
