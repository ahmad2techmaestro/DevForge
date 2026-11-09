"""DevForge-Bench: run DevForge's REAL agent pipeline on small tasks and verify the result with hidden tests.

NOTE: these are DevForge's own tasks (14 tiny repos). They are NOT SWE-bench and the numbers are not
comparable to it. Treat the score as a regression/smoke metric for this service.

Usage (from the ai-service directory, using its virtualenv)::

    python eval/run_bench.py                       # all tasks with the provider from env (default: mock)
    python eval/run_bench.py --list                # show the tasks
    python eval/run_bench.py --tasks py-01-slugify-bug,js-02-sum-empty
    python eval/run_bench.py --limit 3 --out /tmp/bench

    LLM_PROVIDER=gemini    GEMINI_API_KEY=...    python eval/run_bench.py
    LLM_PROVIDER=groq      GROQ_API_KEY=...      python eval/run_bench.py
    LLM_PROVIDER=openai    OPENAI_API_KEY=...    python eval/run_bench.py
    LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=... python eval/run_bench.py

Each task: the fixture repo is indexed, a run is created through the real HTTP API (in-process via
httpx.ASGITransport) with autoApprove, the agent plans/implements/tests/fixes in the subprocess sandbox, then
the final workspace is copied, the original visible tests are restored, the HIDDEN verification tests are
added, and the verification command decides pass/fail. pass@1 = tasks solved on the single attempt.
Results: eval/results/latest.json and eval/results/REPORT.md (override with --out).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import sys
import tempfile
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import httpx  # noqa: E402

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402
from app.sandbox.runner import parse_counts  # noqa: E402
from app.sandbox.subprocess_sandbox import SubprocessSandbox  # noqa: E402

TASKS_DIR = HERE / "tasks"
RESULTS_DIR = HERE / "results"
KEY = "bench-key"
_TEST_FILE = ("test_", "_test.py", ".test.js", ".test.mjs", ".test.ts", ".spec.js")


@dataclass
class Task:
    id: str
    kind: str
    language: str
    title: str
    description: str
    verify_argv: list[str]
    dir: Path

    @property
    def repo(self) -> Path:
        return self.dir / "repo"


@dataclass
class Verification:
    passed: bool
    tests_passed: int = 0
    tests_failed: int = 0
    output: str = ""


@dataclass
class TaskResult:
    id: str
    kind: str
    language: str
    status: str = "error"  # solved | failed | skipped | error
    run_status: str = ""
    verified: bool = False
    tests_passed: int = 0
    tests_failed: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    seconds: float = 0.0
    files_changed: int = 0
    error: str = ""
    verify_tail: str = field(default="", repr=False)


def load_tasks(only: list[str] | None = None, root: Path = TASKS_DIR) -> list[Task]:
    tasks: list[Task] = []
    for d in sorted(p for p in root.iterdir() if (p / "task.json").exists()):
        meta = json.loads((d / "task.json").read_text("utf-8"))
        if only and meta["id"] not in only:
            continue
        tasks.append(Task(meta["id"], meta["kind"], meta["language"], meta["title"], meta["description"],
                          list(meta["verify"]), d))  # fmt: skip
    if only:
        missing = set(only) - {t.id for t in tasks}
        if missing:
            raise SystemExit(f"unknown task id(s): {', '.join(sorted(missing))}")
    return tasks


def _overlay(src: Path, dest: Path, only_tests: bool = False) -> None:
    for f in sorted(src.rglob("*")):
        if not f.is_file():
            continue
        rel = f.relative_to(src)
        if only_tests and not (rel.parts[0] in ("tests", "test") or f.name.startswith(_TEST_FILE) or f.name.endswith(_TEST_FILE)):
            continue
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, target)


def node_available() -> bool:
    return shutil.which("node") is not None


async def verify_workspace(task: Task, workspace: Path, *, timeout: float = 120.0) -> Verification:
    """Copy `workspace`, restore the original visible tests, add the hidden tests and run the verification."""
    with tempfile.TemporaryDirectory(prefix="devforge-bench-verify-") as tmp:
        work = Path(tmp) / "ws"
        shutil.copytree(workspace, work, ignore=shutil.ignore_patterns(".git", "__pycache__", "node_modules", ".pytest_cache"))
        _overlay(task.repo, work, only_tests=True)  # the agent may not rewrite the visible tests
        hidden = task.dir / "verify"
        if hidden.is_dir():
            _overlay(hidden, work)
        res = await SubprocessSandbox().run(task.verify_argv, work, timeout=timeout)
    passed, failed = parse_counts(res.output, res.exit_code)
    ok = res.exit_code == 0 and failed == 0 and passed > 0 and not res.timed_out
    return Verification(ok, passed, failed, res.output[-1500:])


class _Sink:
    """Local HTTP endpoint that swallows the run-event callbacks."""

    def __init__(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                self.send_response(200)
                self.end_headers()

            def log_message(self, *a: object) -> None:
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/events"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def _usage_from(events: list[dict[str, object]]) -> tuple[int, int, float]:
    last = next((e for e in reversed(events) if e.get("type") == "usage"), None)
    data = last.get("data", {}) if last else {}
    return int(data.get("inputTokens", 0)), int(data.get("outputTokens", 0)), float(data.get("costUsd", 0.0))  # type: ignore[union-attr]


async def run_task(
    client: httpx.AsyncClient, settings: Settings, task: Task, scratch: Path, sink_url: str, timeout: float
) -> TaskResult:
    res = TaskResult(task.id, task.kind, task.language)
    if task.language == "javascript" and not node_available():
        res.status, res.error = "skipped", "node not found on PATH"
        return res
    start = time.monotonic()
    repo_id = "bench-" + task.id.replace("_", "-")[:60]
    run_id = f"run-{task.id}"[:90]
    src = scratch / "fixtures" / task.id
    try:
        shutil.copytree(task.repo, src)  # indexing a plain dir copies + git-inits it
        r = await client.post("/repos/index", json={"repoId": repo_id, "localPath": str(src)})
        r.raise_for_status()
        body = {
            "runId": run_id, "taskId": task.id, "repoId": repo_id, "callbackUrl": sink_url,
            "task": {"kind": task.kind if task.kind in ("bugfix", "feature", "refactor") else "feature",
                     "title": task.title, "description": task.description},
            "options": {"autoApprove": True, "maxFixAttempts": 2},
        }  # fmt: skip
        r = await client.post("/runs", json=body)
        r.raise_for_status()
        deadline = time.monotonic() + timeout
        snap: dict[str, object] = {}
        while time.monotonic() < deadline:
            snap = (await client.get(f"/runs/{run_id}")).json()
            if snap["status"] in ("completed", "failed", "cancelled"):
                break
            await asyncio.sleep(0.25)
        else:
            await client.post(f"/runs/{run_id}/cancel")
            res.error = f"run timed out after {timeout:.0f}s"
        res.run_status = str(snap.get("status", ""))
        events: list[dict[str, object]] = snap.get("events", [])  # type: ignore[assignment]
        res.input_tokens, res.output_tokens, res.cost_usd = _usage_from(events)
        failed = next((e for e in reversed(events) if e.get("type") == "run.failed"), None)
        if failed and not res.error:
            res.error = str(failed["data"].get("error", ""))[:300]  # type: ignore[index, union-attr]
        diff = (await client.get(f"/runs/{run_id}/diff")).json() if res.run_status == "completed" else {"files": []}
        res.files_changed = len(diff.get("files", []))
        workspace = settings.runs_dir / run_id / "repo"
        if workspace.is_dir():
            v = await verify_workspace(task, workspace)
            res.verified, res.tests_passed, res.tests_failed, res.verify_tail = v.passed, v.tests_passed, v.tests_failed, v.output
        res.status = "solved" if res.verified else "failed"
    except Exception as exc:  # one broken task must not abort the whole benchmark
        res.status, res.error = "error", f"{type(exc).__name__}: {exc}"[:300]
    res.seconds = round(time.monotonic() - start, 2)
    return res


def summarize(results: list[TaskResult]) -> dict[str, object]:
    ran = [r for r in results if r.status != "skipped"]
    solved = [r for r in ran if r.status == "solved"]
    return {
        "tasks": len(results), "ran": len(ran), "skipped": len(results) - len(ran), "solved": len(solved),
        "pass_at_1": round(len(solved) / len(ran), 4) if ran else 0.0,
        "input_tokens": sum(r.input_tokens for r in ran), "output_tokens": sum(r.output_tokens for r in ran),
        "cost_usd": round(sum(r.cost_usd for r in ran), 6),
        "seconds_total": round(sum(r.seconds for r in ran), 2),
        "seconds_mean": round(sum(r.seconds for r in ran) / len(ran), 2) if ran else 0.0,
    }  # fmt: skip


def render_report(meta: dict[str, object], summary: dict[str, object], results: list[TaskResult]) -> str:
    lines = [
        "# DevForge-Bench report", "",
        f"- Provider / model: `{meta['provider']}` / `{meta['model']}`",
        f"- Date: {meta['date']}  |  Sandbox: {meta['sandbox']}  |  Node: {meta['node']}",
        f"- **pass@1: {summary['solved']}/{summary['ran']} = {float(summary['pass_at_1']):.0%}**"  # type: ignore[arg-type]
        f" ({summary['skipped']} skipped)",
        f"- Tokens: {summary['input_tokens']} in / {summary['output_tokens']} out  |  cost: ${float(summary['cost_usd']):.4f}"  # type: ignore[arg-type]
        f"  |  mean time/task: {summary['seconds_mean']}s", "",
        "| Task | Kind | Lang | Result | Run | Hidden tests (pass/fail) | Tokens in/out | Cost USD | Time s |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for r in results:
        mark = {"solved": "PASS", "failed": "FAIL", "skipped": "SKIP", "error": "ERROR"}[r.status]
        lines.append(
            f"| {r.id} | {r.kind} | {r.language} | {mark} | {r.run_status or '-'} | {r.tests_passed}/{r.tests_failed} "
            f"| {r.input_tokens}/{r.output_tokens} | {r.cost_usd:.4f} | {r.seconds} |"
        )
    errs = [r for r in results if r.error]
    if errs:
        lines += ["", "## Errors", ""] + [f"- `{r.id}`: {r.error}" for r in errs]
    lines += [
        "", "_These are DevForge's own tasks, not SWE-bench. With `LLM_PROVIDER=mock` the offline provider cannot "
        "write code, so a low score there is expected and honest._", "",
    ]
    return "\n".join(lines)


async def run_bench(
    settings: Settings, task_ids: list[str] | None = None, out_dir: Path | None = None, *,
    limit: int | None = None, timeout: float = 900.0, tasks_root: Path = TASKS_DIR,
) -> dict[str, object]:
    tasks = load_tasks(task_ids, tasks_root)
    if limit:
        tasks = tasks[:limit]
    results: list[TaskResult] = []
    with tempfile.TemporaryDirectory(prefix="devforge-bench-") as tmp:
        scratch = Path(tmp)
        cfg = settings.model_copy(update={"workdir": scratch / "data", "sandbox": "subprocess", "internal_key": KEY})
        sink = _Sink()
        try:
            app = create_app(cfg, sandbox=SubprocessSandbox())
            async with app.router.lifespan_context(app):
                transport = httpx.ASGITransport(app=app)
                async with httpx.AsyncClient(transport=transport, base_url="http://bench", headers={"X-Internal-Key": KEY}, timeout=60) as client:
                    for t in tasks:
                        print(f"[bench] {t.id} ...", flush=True)
                        r = await run_task(client, cfg, t, scratch, sink.url, timeout)
                        print(f"[bench]   -> {r.status} ({r.seconds}s, {r.input_tokens + r.output_tokens} tok)", flush=True)
                        results.append(r)
        finally:
            sink.close()
    meta = {
        "provider": settings.llm_provider, "model": settings.model, "sandbox": "subprocess",
        "node": "yes" if node_available() else "no", "date": datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC"),
        "note": "DevForge's own tasks; not SWE-bench.",
    }  # fmt: skip
    summary = summarize(results)
    report = {"meta": meta, "summary": summary, "tasks": [{k: v for k, v in asdict(r).items() if k != "verify_tail"} for r in results]}
    out = out_dir or RESULTS_DIR
    out.mkdir(parents=True, exist_ok=True)
    (out / "latest.json").write_text(json.dumps(report, indent=2) + "\n", "utf-8")
    (out / "REPORT.md").write_text(render_report(meta, summary, results), "utf-8")
    return report


def main() -> None:
    ap = argparse.ArgumentParser(description="DevForge-Bench")
    ap.add_argument("--tasks", help="comma-separated task ids")
    ap.add_argument("--limit", type=int, help="only the first N tasks")
    ap.add_argument("--out", type=Path, help="output directory (default eval/results)")
    ap.add_argument("--timeout", type=float, default=900.0, help="per-task wall-clock limit in seconds")
    ap.add_argument("--list", action="store_true", help="list tasks and exit")
    args = ap.parse_args()
    only = args.tasks.split(",") if args.tasks else None
    if args.list:
        for t in load_tasks(only):
            print(f"{t.id:34} {t.kind:9} {t.language:11} {t.title}")
        return
    settings = Settings.from_env()
    print(f"[bench] provider={settings.llm_provider} model={settings.model}", flush=True)
    report = asyncio.run(run_bench(settings, only, args.out, limit=args.limit, timeout=args.timeout))
    s = report["summary"]
    print(f"[bench] pass@1 = {s['solved']}/{s['ran']}  cost=${s['cost_usd']}  -> {(args.out or RESULTS_DIR) / 'REPORT.md'}")  # type: ignore[index]


if __name__ == "__main__":
    main()
