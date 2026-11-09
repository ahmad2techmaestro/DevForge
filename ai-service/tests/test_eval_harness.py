"""DevForge-Bench harness: report format, and that hidden verification tells good fixes from bad ones."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from eval.run_bench import (
    _overlay,
    load_tasks,
    node_available,
    render_report,
    run_bench,
    summarize,
    verify_workspace,
)

TASKS = load_tasks()


def test_task_inventory() -> None:
    assert len(TASKS) >= 12
    assert {t.kind for t in TASKS} >= {"bugfix", "feature", "refactor"}
    assert {t.language for t in TASKS} == {"python", "javascript"}
    for t in TASKS:
        assert (t.dir / "verify").is_dir() and (t.dir / "solution").is_dir() and t.repo.is_dir()
        assert t.description and t.title


@pytest.mark.parametrize("task", TASKS, ids=lambda t: t.id)
async def test_verification_rejects_unfixed_and_accepts_reference(task, tmp_path: Path) -> None:
    if task.language == "javascript" and not node_available():
        pytest.skip("node not installed")
    ws = tmp_path / "ws"
    shutil.copytree(task.repo, ws)
    broken = await verify_workspace(task, ws)
    assert not broken.passed, f"{task.id}: hidden tests must fail on the unmodified fixture"
    _overlay(task.dir / "solution", ws)
    fixed = await verify_workspace(task, ws)
    assert fixed.passed and fixed.tests_failed == 0 and fixed.tests_passed > 0, fixed.output


async def test_verification_ignores_tampered_visible_tests_and_partial_fixes(tmp_path: Path) -> None:
    task = next(t for t in TASKS if t.id == "py-01-slugify-bug")
    ws = tmp_path / "ws"
    shutil.copytree(task.repo, ws)
    # A "fix" that only satisfies the visible test, plus the agent deleting/neutering the visible tests.
    (ws / "slug.py").write_text('import re\n\n\ndef slugify(text):\n    return re.sub(r"[^a-z0-9]", "-", text.lower()).replace("--", "-").strip("-")\n')
    (ws / "tests" / "test_slug.py").write_text("def test_nothing():\n    pass\n")
    partial = await verify_workspace(task, ws)
    assert not partial.passed and partial.tests_failed >= 1
    _overlay(task.dir / "solution", ws)
    assert (await verify_workspace(task, ws)).passed


async def test_bench_with_mock_is_honest_and_well_formed(settings, tmp_path: Path) -> None:
    out = tmp_path / "out"
    ids = ["py-01-slugify-bug", "py-05-stack-empty", "py-09-calc-dispatch-refactor"]
    report = await run_bench(settings, ids, out, timeout=180)

    assert (out / "REPORT.md").is_file() and (out / "latest.json").is_file()
    data = json.loads((out / "latest.json").read_text("utf-8"))
    assert data == report
    assert set(data) == {"meta", "summary", "tasks"}
    assert data["meta"]["provider"] == "mock" and "SWE-bench" in data["meta"]["note"]
    s = data["summary"]
    assert {"tasks", "ran", "solved", "pass_at_1", "input_tokens", "output_tokens", "cost_usd", "seconds_total"} <= set(s)
    assert s["ran"] == 3 and s["solved"] == 0 and s["pass_at_1"] == 0.0  # the mock cannot write code: no free passes
    assert [t["id"] for t in data["tasks"]] == sorted(ids)
    for t in data["tasks"]:
        assert t["status"] == "failed" and t["verified"] is False and t["run_status"] == "completed"
        assert {"input_tokens", "output_tokens", "cost_usd", "seconds", "tests_passed", "tests_failed"} <= set(t)
        assert t["input_tokens"] > 0 and t["seconds"] > 0
    md = (out / "REPORT.md").read_text("utf-8")
    assert "| Task | Kind |" in md and "py-05-stack-empty" in md and "pass@1: 0/3" in md and "not SWE-bench" in md


def test_summary_and_report_rendering() -> None:
    from eval.run_bench import TaskResult

    rs = [TaskResult("a", "bugfix", "python", status="solved", input_tokens=10, output_tokens=5, cost_usd=0.01, seconds=2),
          TaskResult("b", "bugfix", "python", status="failed", seconds=4),
          TaskResult("c", "feature", "javascript", status="skipped", error="node not found on PATH")]  # fmt: skip
    s = summarize(rs)
    assert s["ran"] == 2 and s["solved"] == 1 and s["pass_at_1"] == 0.5 and s["skipped"] == 1 and s["seconds_mean"] == 3.0
    md = render_report({"provider": "p", "model": "m", "date": "d", "sandbox": "s", "node": "no"}, s, rs)
    assert "pass@1: 1/2 = 50%" in md and "SKIP" in md and "node not found" in md
