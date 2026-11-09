from __future__ import annotations

from pathlib import Path

from app.llm.loop import extract_json, run_tool_loop
from app.llm.tools import WorkspaceTools
from app.llm.usage import UsageMeter
from app.sandbox.subprocess_sandbox import SubprocessSandbox
from tests.conftest import ScriptedChatModel, ai


def make(tmp_path: Path, events: list) -> WorkspaceTools:
    async def emit(t: str, d: dict[str, object]) -> None:
        events.append((t, d))

    (tmp_path / "a.py").write_text("x = 1\n")
    return WorkspaceTools(tmp_path, SubprocessSandbox(), emit)


async def test_loop_executes_tools_and_accounts_usage(tmp_path: Path) -> None:
    events: list = []
    tools = make(tmp_path, events)
    model = ScriptedChatModel(script=[
        ai("", [("read_file", {"path": "a.py"}), ("write_file", {"path": "b.py", "content": "y = 2\n"})]),
        ai("", [("read_file", {"path": "../../etc/passwd"})]),
        ai("All done.", i=200, o=20),
    ])  # fmt: skip
    meter = UsageMeter("claude-sonnet-4-5")
    text = await run_tool_loop(model, "sys", "go", tools, meter, tools.emit, max_iterations=10, token_budget=10_000)
    assert text == "All done." and (tmp_path / "b.py").read_text() == "y = 2\n"
    assert meter.input_tokens == 400 and meter.output_tokens == 120
    assert meter.snapshot().costUsd > 0
    results = [d for t, d in events if t == "tool.result"]
    assert [r["ok"] for r in results] == [True, True, False]  # path escape reported, loop continues


async def test_loop_respects_max_iterations_and_budget(tmp_path: Path) -> None:
    events: list = []
    tools = make(tmp_path, events)
    forever = ScriptedChatModel(script=[ai("again", [("list_files", {})])])
    meter = UsageMeter("mock")
    await run_tool_loop(forever, "s", "u", tools, meter, tools.emit, max_iterations=3, token_budget=10**9)
    assert forever.cursor == 3
    assert any(t == "log" and "iterations" in str(d) for t, d in events)

    forever2 = ScriptedChatModel(script=[ai("again", [("list_files", {})], i=600, o=600)])
    meter2 = UsageMeter("mock")
    await run_tool_loop(forever2, "s", "u", tools, meter2, tools.emit, max_iterations=50, token_budget=2000)
    assert forever2.cursor <= 3
    assert any("token budget" in str(d) for t, d in events if t == "log")


async def test_unknown_tool_is_reported_not_raised(tmp_path: Path) -> None:
    events: list = []
    tools = make(tmp_path, events)
    model = ScriptedChatModel(script=[ai("", [("format_disk", {})]), ai("ok")])
    await run_tool_loop(model, "s", "u", tools, UsageMeter("mock"), tools.emit, max_iterations=5, token_budget=10_000)
    assert [d["ok"] for t, d in events if t == "tool.result"] == [False]


def test_extract_json() -> None:
    assert extract_json('noise ```json\n{"a": 1}\n``` tail') == {"a": 1}
    assert extract_json('Here: {"a": {"b": 2}} done') == {"a": {"b": 2}}
    assert extract_json("no json") is None
