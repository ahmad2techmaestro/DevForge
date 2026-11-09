from __future__ import annotations

import json
import subprocess
from pathlib import Path

import httpx

from app.config import Settings
from app.llm.provider import model_brain_factory
from tests.conftest import Receiver, ScriptedChatModel, ai, index_repo, make_repo, running, wait_for


def body(run_id: str, receiver: Receiver, kind: str = "tests", title: str = "Add calculator tests", **opts: object) -> dict[str, object]:
    return {
        "runId": run_id, "taskId": "t-" + run_id, "repoId": "repo1", "callbackUrl": receiver.url,
        "task": {"kind": kind, "title": title, "description": "cover the calc ops module"},
        "options": opts,
    }  # fmt: skip


async def status(c: httpx.AsyncClient, run_id: str) -> dict:
    return (await c.get(f"/runs/{run_id}")).json()


async def wait_status(c: httpx.AsyncClient, run_id: str, *wanted: str) -> dict:
    async def ok() -> bool:
        return (await status(c, run_id))["status"] in wanted

    await wait_for(ok)
    return await status(c, run_id)


async def approve(c: httpx.AsyncClient, run_id: str, decision: str = "approve", feedback: str | None = None, **extra: object) -> httpx.Response:
    pending = (await status(c, run_id))["pendingApproval"]
    return await c.post(f"/runs/{run_id}/approve", json={"approvalId": pending["approvalId"], "decision": decision, "feedback": feedback, **extra})


def assert_sequenced(events: list[dict]) -> None:
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
    assert all(e["ts"].endswith("Z") for e in events)


async def test_mock_tests_run_end_to_end(settings: Settings, py_repo: Path, receiver: Receiver) -> None:
    async with running(settings) as (c, _):
        await index_repo(c, py_repo)
        r = await c.post("/runs", json=body("r1", receiver))
        assert r.status_code == 202 and r.json() == {"runId": "r1", "status": "running"}

        snap = await wait_status(c, "r1", "awaiting_approval")
        pa = snap["pendingApproval"]
        assert pa["kind"] == "plan" and 2 <= len(pa["payload"]["steps"]) <= 3
        wrong = await c.post("/runs/r1/approve", json={"approvalId": "bogus", "decision": "approve"})
        assert wrong.status_code == 409

        first = await c.post("/runs/r1/approve", json={"approvalId": pa["approvalId"], "decision": "approve"})
        assert first.json() == {"ok": True}
        again = await c.post("/runs/r1/approve", json={"approvalId": pa["approvalId"], "decision": "approve"})
        assert again.status_code == 409  # a decision can only be submitted once
        snap = await wait_status(c, "r1", "awaiting_approval", "failed")
        assert snap["status"] == "awaiting_approval" and snap["pendingApproval"]["kind"] == "changes"
        assert snap["pendingApproval"]["payload"]["tests"]["ok"] is True

        # commit/push are refused before the changes are approved
        pre = await c.post("/runs/r1/commit", json={"branch": "devforge/x", "message": "m"})
        assert pre.status_code == 409 and pre.json()["error"]["code"] == "not_approved"

        diff = (await c.get("/runs/r1/diff")).json()
        assert any(f["path"].startswith("tests/test_devforge_smoke_calc_ops") for f in diff["files"])
        assert "def test_module_imports" in diff["diff"]

        await approve(c, "r1")
        snap = await wait_status(c, "r1", "completed", "failed")
    assert snap["status"] == "completed", snap["events"][-3:]
    await wait_for(lambda: "run.completed" in receiver.types())

    events = snap["events"]
    assert_sequenced(events)
    assert receiver.events == events  # delivered in order, identical to GET resync
    assert set(receiver.keys) == {"test-key"}
    types = [e["type"] for e in events]
    for t in ["run.started", "plan.proposed", "approval.requested", "approval.resolved", "tool.call",
              "tool.result", "file.changed", "tests.started", "tests.result", "diff.ready",
              "review.result", "pr.draft", "usage", "run.completed"]:  # fmt: skip
        assert t in types, t
    assert types[0] == "run.started" and types[-1] == "run.completed"
    nodes = [e["data"]["node"] for e in events if e["type"] == "node.started"]
    assert nodes == ["classify", "plan", "implement", "test", "review", "pr_draft"]
    result = next(e for e in events if e["type"] == "tests.result")["data"]
    assert result["ok"] and result["passed"] >= 2 and result["failed"] == 0 and result["framework"] == "pytest"
    assert result["sandbox"] == "subprocess"
    started = next(e for e in events if e["type"] == "run.started")["data"]
    assert started["provider"] == "mock" and started["sandbox"] == "subprocess"
    usage = [e["data"] for e in events if e["type"] == "usage"]
    assert usage and all(u["inputTokens"] <= v["inputTokens"] for u, v in zip(usage, usage[1:], strict=False))
    # the indexed repo was never mutated
    assert not (settings.repos_dir / "repo1" / "tests").exists()
    pr = next(e for e in events if e["type"] == "pr.draft")["data"]
    assert pr["branch"].startswith("devforge/tests-") and "Tests:" in pr["body"]


async def test_reject_plan_with_feedback_reenters_plan_then_fails_after_three(settings, py_repo, receiver) -> None:
    async with running(settings) as (c, _):
        await index_repo(c, py_repo)
        await c.post("/runs", json=body("r2", receiver, kind="feature", title="Add widget"))
        await wait_status(c, "r2", "awaiting_approval")
        await approve(c, "r2", "reject", "please be more specific about widgets")
        snap = await wait_status(c, "r2", "awaiting_approval")
        steps = snap["pendingApproval"]["payload"]["steps"]
        assert "please be more specific" in json.dumps(steps)  # feedback reached the planner
        await approve(c, "r2", "reject", "no")
        await wait_status(c, "r2", "awaiting_approval")
        await approve(c, "r2", "reject", "still no")
        snap = await wait_status(c, "r2", "failed")
    assert "rejected 3 times" in snap["events"][-1]["data"]["error"]
    assert snap["events"][-1]["type"] == "run.failed"
    assert sum(1 for e in snap["events"] if e["type"] == "plan.proposed") == 3
    assert_sequenced(snap["events"])


async def test_changes_rejection_reenters_implement_and_edited_plan(settings, py_repo, receiver) -> None:
    async with running(settings) as (c, _):
        await index_repo(c, py_repo)
        await c.post("/runs", json=body("r3", receiver, kind="feature", title="Add widget"))
        await wait_status(c, "r3", "awaiting_approval")
        edited = [{"id": "e1", "title": "Edited step", "detail": "hand written", "files": ["calc/ops.py"]}]
        await approve(c, "r3", editedPlan=edited)
        snap = await wait_status(c, "r3", "awaiting_approval")
        assert snap["pendingApproval"]["kind"] == "changes"
        d1 = (await c.get("/runs/r3/diff")).json()
        assert "Edited step" in d1["diff"] and d1["files"][0]["path"] == "docs/DEVFORGE_CHANGES.md"
        await approve(c, "r3", "reject", "mention the rollout")
        snap = await wait_status(c, "r3", "awaiting_approval")
        assert snap["pendingApproval"]["kind"] == "changes"
        assert "mention the rollout" in (await c.get("/runs/r3/diff")).json()["diff"]
        await approve(c, "r3")
        snap = await wait_status(c, "r3", "completed")
    impl_runs = [e for e in snap["events"] if e["type"] == "node.started" and e["data"]["node"] == "implement"]
    assert len(impl_runs) == 2
    resolved = [e["data"]["decision"] for e in snap["events"] if e["type"] == "approval.resolved"]
    assert resolved == ["approve", "reject", "approve"]


async def test_auto_approve_emits_events_and_skips_interrupts(settings, py_repo, receiver) -> None:
    async with running(settings) as (c, _):
        await index_repo(c, py_repo)
        await c.post("/runs", json=body("r4", receiver, autoApprove=True))
        snap = await wait_status(c, "r4", "completed", "failed")
    assert snap["status"] == "completed"
    req = [e for e in snap["events"] if e["type"] == "approval.requested"]
    res = [e["data"] for e in snap["events"] if e["type"] == "approval.resolved"]
    assert [e["data"]["kind"] for e in req] == ["plan", "changes"]
    assert all(r["decision"] == "approve" and r["feedback"] == "auto-approved" for r in res) and len(res) == 2
    assert res[0]["approvalId"] == req[0]["data"]["approvalId"]


async def test_review_and_explain_kinds_skip_implement(settings, py_repo, receiver) -> None:
    async with running(settings) as (c, _):
        await index_repo(c, py_repo)
        for kind in ("review", "explain"):
            rid = f"r-{kind}"
            await c.post("/runs", json=body(rid, receiver, kind=kind, title="ops module", autoApprove=True))
            snap = await wait_status(c, rid, "completed", "failed")
            assert snap["status"] == "completed"
            nodes = [e["data"]["node"] for e in snap["events"] if e["type"] == "node.started"]
            assert nodes == ["classify", "plan", "review"]
            kinds = {e["data"].get("kind") for e in snap["events"] if e["type"] == "approval.requested"}
            assert kinds == {"plan"}
            assert any(e["type"] == "review.result" for e in snap["events"])
            assert not any(e["type"] in ("file.changed", "pr.draft") for e in snap["events"])
        assert (await c.get("/runs/r-review/diff")).json()["files"] == []


async def test_cancel_while_awaiting_approval(settings, py_repo, receiver) -> None:
    async with running(settings) as (c, _):
        await index_repo(c, py_repo)
        await c.post("/runs", json=body("r5", receiver))
        await wait_status(c, "r5", "awaiting_approval")
        assert (await c.post("/runs/r5/cancel")).json() == {"ok": True}
        snap = await wait_status(c, "r5", "cancelled")
        assert snap["events"][-1] == {**snap["events"][-1], "type": "run.cancelled", "data": {}}
        assert (await c.post("/runs/r5/cancel")).json() == {"ok": True}  # idempotent
        late = await c.post("/runs/r5/approve", json={"approvalId": "x", "decision": "approve"})
        assert late.status_code == 409


async def test_callback_retries_with_backoff(settings, py_repo, receiver) -> None:
    receiver.fail_first = 2
    async with running(settings) as (c, _):
        await index_repo(c, py_repo)
        await c.post("/runs", json=body("r6", receiver, kind="explain", autoApprove=True))
        snap = await wait_status(c, "r6", "completed")
        await wait_for(lambda: len(receiver.events) == len(snap["events"]))
    assert receiver.attempts == len(snap["events"]) + 2
    assert [e["seq"] for e in receiver.events] == list(range(1, len(snap["events"]) + 1))


async def test_resync_after_restart_from_disk(settings, py_repo, receiver) -> None:
    async with running(settings) as (c, _):
        await index_repo(c, py_repo)
        await c.post("/runs", json=body("r7", receiver, kind="explain", autoApprove=True))
        before = await wait_status(c, "r7", "completed")
    async with running(settings) as (c2, _):
        after = await status(c2, "r7")
        assert after["status"] == "completed" and after["events"] == before["events"]
        assert (await c2.get("/runs/nope")).status_code == 404
        dup = await c2.post("/runs", json=body("r7", receiver))
        assert dup.status_code == 409


async def test_interrupted_run_marked_failed_after_restart(settings, py_repo, receiver) -> None:
    async with running(settings) as (c, _):
        await index_repo(c, py_repo)
        await c.post("/runs", json=body("r8", receiver))
        await wait_status(c, "r8", "awaiting_approval")
        # a second process starting on the same WORKDIR while the first is stuck/dead
        async with running(settings) as (c2, _):
            snap = await status(c2, "r8")
    last = snap["events"][-1]
    assert snap["status"] == "failed" and last["type"] == "run.failed" and "restarted" in last["data"]["error"]


async def test_run_validation_errors(client, py_repo, receiver) -> None:
    await index_repo(client, py_repo)
    bad = body("r9", receiver)
    bad["task"] = {"kind": "nonsense", "title": "x"}
    r = await client.post("/runs", json=bad)
    assert r.status_code == 400 and r.json()["error"]["code"] == "validation_error"
    nokrepo = {**body("r10", receiver), "repoId": "unknown"}
    assert (await client.post("/runs", json=nokrepo)).status_code == 404
    assert (await client.post("/runs", json={**body("../x", receiver)})).status_code == 400


async def test_commit_and_push_to_local_bare_remote(settings, py_repo, receiver, tmp_path) -> None:
    bare = tmp_path / "remote.git"
    subprocess.run(["git", "init", "-q", "--bare", str(bare)], check=True)
    async with running(settings, allow_local_push=True) as (c, _):
        await index_repo(c, py_repo)
        await c.post("/runs", json=body("r11", receiver, autoApprove=True))
        await wait_status(c, "r11", "completed")
        r = await c.post("/runs/r11/commit", json={"branch": "devforge/tests-x", "message": "Add tests",
                                                    "authorName": "Ada", "authorEmail": "ada@example.com"})  # fmt: skip
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["branch"] == "devforge/tests-x" and len(out["commit"]) == 40 and out["files"]
        ws = settings.runs_dir / "r11" / "repo"
        author = subprocess.run(["git", "log", "-1", "--format=%an <%ae>"], cwd=ws, capture_output=True, text=True).stdout.strip()
        assert author == "Ada <ada@example.com>"
        assert (await c.post("/runs/r11/commit", json={"branch": "bad branch..", "message": "m"})).status_code == 400
        nopush = await c.post("/runs/r11/push", json={"cloneUrl": str(bare), "branch": "other", "token": "t"})
        assert nopush.status_code == 409
        p = await c.post("/runs/r11/push", json={"cloneUrl": str(bare), "branch": "devforge/tests-x", "token": "tok_secret"})
        assert p.status_code == 200 and p.json() == {"pushed": True, "branch": "devforge/tests-x"}
        cred = await c.post("/runs/r11/push", json={"cloneUrl": "https://u:p@github.com/a/b.git", "branch": "devforge/tests-x", "token": "t"})
        assert cred.status_code == 400
        ssh = await c.post("/runs/r11/push", json={"cloneUrl": "ssh://git@github.com/a/b.git", "branch": "devforge/tests-x", "token": "t"})
        assert ssh.status_code == 400
    refs = subprocess.run(["git", "branch", "--list"], cwd=bare, capture_output=True, text=True).stdout
    assert "devforge/tests-x" in refs
    cfg = (ws / ".git" / "config").read_text()
    assert "tok_secret" not in cfg and "extraheader" not in cfg  # nothing persisted


async def test_commit_refuses_secrets(settings, tmp_path, receiver) -> None:
    repo = make_repo(tmp_path / "r", {"app.py": "def f():\n    return 1\n"})
    token = "ghp_" + "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe"
    script = ScriptedChatModel(script=[
        ai('{"summary":"s","steps":[{"title":"t","detail":"d","files":["app.py"]}]}'),
        ai("", [("write_file", {"path": "ok.py", "content": f"X = '{token}'\n"})]),  # refused by the tool
        ai("", [("run_command", {"command": f"printf 'TOKEN = \"{token}\"\\n' > leak.py"})]),  # sneaks past tool check
        ai("done"),
        ai('{"summary":"ok","comments":[]}'),
    ])  # fmt: skip
    st = settings.model_copy(update={"llm_provider": "anthropic", "anthropic_api_key": "x"})
    async with running(st, model_brain_factory(script, st)) as (c, _):
        await index_repo(c, repo)
        await c.post("/runs", json={**body("r12", receiver, kind="feature"), "options": {"autoApprove": True}})
        snap = await wait_status(c, "r12", "completed", "failed")
        assert snap["status"] == "completed", snap["events"][-2:]
        assert token not in json.dumps(snap["events"])
        r = await c.post("/runs/r12/commit", json={"branch": "devforge/leak", "message": "m"})
        assert r.status_code == 422 and r.json()["error"]["code"] == "secrets_detected"
        assert token not in r.text


async def test_real_provider_loop_full_run_with_scripted_model(settings, py_repo, receiver) -> None:
    test_src = "from calc.ops import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n"
    script = ScriptedChatModel(script=[
        ai("", [("search_code", {"query": "add"})]),
        ai('```json\n{"summary":"Add a test","steps":[{"title":"Write test","detail":"d","files":["tests/test_add.py"]}]}\n```'),
        ai("", [("write_file", {"path": "tests/test_add.py", "content": test_src})]),
        ai("", [("run_tests", {})]),
        ai("Added tests/test_add.py."),
        ai('{"summary":"Looks good","comments":[{"path":"tests/test_add.py","line":1,"severity":"low","body":"nit"}]}'),
    ])  # fmt: skip
    st = settings.model_copy(update={"llm_provider": "anthropic", "anthropic_api_key": "x"})
    async with running(st, model_brain_factory(script, st)) as (c, _):
        await index_repo(c, py_repo)
        await c.post("/runs", json=body("r13", receiver, autoApprove=True))
        snap = await wait_status(c, "r13", "completed", "failed")
    assert snap["status"] == "completed", snap["events"][-2:]
    ev = snap["events"]
    calls = [e["data"]["name"] for e in ev if e["type"] == "tool.call"]
    assert calls == ["search_code", "write_file", "run_tests"]
    tr = next(e for e in ev if e["type"] == "tests.result")["data"]
    assert tr["ok"] and tr["passed"] == 1
    rv = next(e for e in ev if e["type"] == "review.result")["data"]
    assert rv["summary"] == "Looks good" and any(c["body"] == "nit" for c in rv["comments"])
    last_usage = [e["data"] for e in ev if e["type"] == "usage"][-1]
    assert last_usage["inputTokens"] == 600 and last_usage["costUsd"] > 0
    assert next(e for e in ev if e["type"] == "run.started")["data"]["provider"] == "anthropic"


async def test_failing_tests_trigger_fix_loop_up_to_max(settings, py_repo, receiver) -> None:
    bad = "def test_bad():\n    assert 0\n"
    good = "def test_bad():\n    assert 1\n"
    script = ScriptedChatModel(script=[
        ai('{"summary":"s","steps":[{"title":"t","detail":"d","files":[]}]}'),
        ai("", [("write_file", {"path": "tests/test_bad.py", "content": bad})]),
        ai("wrote failing test"),  # implement ends
        ai("", [("write_file", {"path": "tests/test_bad.py", "content": good})]),  # fix attempt 1
        ai("fixed"),
        ai('{"summary":"r","comments":[]}'),
    ])  # fmt: skip
    st = settings.model_copy(update={"llm_provider": "openai", "openai_api_key": "x"})
    async with running(st, model_brain_factory(script, st)) as (c, _):
        await index_repo(c, py_repo)
        await c.post("/runs", json=body("r14", receiver, autoApprove=True, maxFixAttempts=2))
        snap = await wait_status(c, "r14", "completed", "failed")
    ev = snap["events"]
    results = [e["data"]["ok"] for e in ev if e["type"] == "tests.result"]
    assert results == [False, True]
    nodes = [e["data"]["node"] for e in ev if e["type"] == "node.started"]
    assert nodes == ["classify", "plan", "implement", "test", "fix", "test", "review", "pr_draft"]


async def test_fix_loop_gives_up_after_max_attempts(settings, py_repo, receiver) -> None:
    bad = "def test_bad():\n    assert 0\n"
    script = ScriptedChatModel(script=[
        ai('{"summary":"s","steps":[{"title":"t","detail":"d","files":[]}]}'),
        ai("", [("write_file", {"path": "tests/test_bad.py", "content": bad})]),
        ai("done"),
    ])  # fmt: skip
    st = settings.model_copy(update={"llm_provider": "openai", "openai_api_key": "x"})
    async with running(st, model_brain_factory(script, st)) as (c, _):
        await index_repo(c, py_repo)
        await c.post("/runs", json=body("r15", receiver, autoApprove=True, maxFixAttempts=1))
        snap = await wait_status(c, "r15", "completed", "failed")
    nodes = [e["data"]["node"] for e in snap["events"] if e["type"] == "node.started"]
    assert nodes == ["classify", "plan", "implement", "test", "fix", "test", "review", "pr_draft"]
    assert [e["data"]["ok"] for e in snap["events"] if e["type"] == "tests.result"] == [False, False]
    assert snap["status"] == "completed"  # still reaches review; the failure is flagged there
    rv = next(e for e in snap["events"] if e["type"] == "review.result")["data"]
    assert any("Tests are failing" in c["body"] for c in rv["comments"])


async def test_repo_memory_is_loaded_and_validated(settings, py_repo, receiver) -> None:
    async with running(settings) as (c, _):
        await index_repo(c, py_repo)
        req = body("mem1", receiver, autoApprove=True)
        req["memory"] = ["Use pytest fixtures, never unittest.TestCase", "  ", "Reviewer rejected: too many files"]
        assert (await c.post("/runs", json=req)).status_code == 202
        await wait_status(c, "mem1", "completed", "failed")
        events = (await c.get("/runs/mem1")).json()["events"]
        msgs = [e["data"]["message"] for e in events if e["type"] == "log"]
        assert any("loaded 2 repository memory note(s)" in m for m in msgs)

        too_many = body("mem2", receiver)
        too_many["memory"] = [f"note {i}" for i in range(31)]
        assert (await c.post("/runs", json=too_many)).status_code == 400
