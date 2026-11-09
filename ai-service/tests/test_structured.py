import json
from pathlib import Path

import httpx
import pytest

from app.llm import structured as st
from app.llm.provider import ChatModelBrain, build_reranker
from app.llm.structured import PlanOut, RankOut, parse
from app.repo.rerank import HttpReranker, LlmReranker, apply_rerank
from tests.fake_openai import FakeOpenAI, error, text, tool_call
from tests.test_providers import _index, brain, cfg, emit, fake, fast_retries  # noqa: F401

PLAN = {"summary": "S", "requirements": ["WHEN a THEN b"], "design": "D", "steps": [{"title": "T", "detail": "d", "files": ["a.py"]}]}


@pytest.fixture(autouse=True)
def reset_modes():
    st._rejected.clear()
    yield
    st._rejected.clear()


def test_parse_is_tolerant_and_strict():
    assert parse("```json\n" + json.dumps(PLAN) + "\n```", PlanOut).steps[0].title == "T"  # type: ignore[union-attr]
    assert parse("no json here", PlanOut) is None
    assert parse('{"steps": [{"detail": "missing title"}]}', PlanOut) is None  # schema violation, not garbage-in


async def test_native_json_schema_is_requested(tmp_path: Path, fake: FakeOpenAI):  # noqa: F811
    b, meter = brain(cfg(tmp_path, fake))
    fake.queue(text(json.dumps({"ranking": [2, 0]})))
    out = await b._structured("rerank", [], RankOut)
    assert out.ranking == [2, 0]
    rf = fake.chat_requests[0]["response_format"]
    assert rf["type"] == "json_schema" and rf["json_schema"]["name"] == "RankOut"


async def test_falls_back_when_provider_rejects_schema_mode_and_remembers(tmp_path: Path, fake: FakeOpenAI):  # noqa: F811
    b, _ = brain(cfg(tmp_path, fake))
    fake.queue(error(400), text(json.dumps({"ranking": [1]})), text(json.dumps({"ranking": [3]})))
    assert (await b._structured("rerank", [], RankOut)).ranking == [1]
    assert [r["response_format"]["type"] for r in fake.chat_requests] == ["json_schema", "json_object"]
    assert (await b._structured("rerank", [], RankOut)).ranking == [3]
    assert fake.chat_requests[2]["response_format"]["type"] == "json_object"  # json_schema is skipped after a 400


async def test_prompt_route_when_native_modes_all_fail(tmp_path: Path, fake: FakeOpenAI):  # noqa: F811
    b, _ = brain(cfg(tmp_path, fake))
    fake.queue(error(400), error(422), text("Sure! " + json.dumps({"ranking": [0]})))
    assert (await b._structured("rerank", [], RankOut)).ranking == [0]
    assert "response_format" not in fake.chat_requests[2]
    assert "JSON schema" in fake.chat_requests[2]["messages"][-1]["content"]


async def test_invalid_output_returns_none_not_garbage(tmp_path: Path, fake: FakeOpenAI):  # noqa: F811
    b, _ = brain(cfg(tmp_path, fake))
    fake.queue(text("I cannot"), text("still not json"), text("nope"))
    assert await b._structured("rerank", [], RankOut) is None


async def test_auth_errors_are_not_swallowed(tmp_path: Path, fake: FakeOpenAI):  # noqa: F811
    from app.errors import ApiError

    b, _ = brain(cfg(tmp_path, fake))
    fake.queue(error(401))
    with pytest.raises(ApiError, match="credentials"):
        await b._structured("rerank", [], RankOut)


async def test_plan_is_repaired_when_the_model_returns_prose(tmp_path: Path, fake: FakeOpenAI):  # noqa: F811
    b, _ = brain(cfg(tmp_path, fake))
    fake.queue(tool_call("read_file", {"path": "a.py"}), text("I think we should edit f in a.py and add a test."), text(json.dumps(PLAN)))
    plan = await b.plan(_index(tmp_path), "feature", "T", "desc", None, emit)
    assert plan.summary == "S" and plan.requirements == ["WHEN a THEN b"] and plan.design == "D" and plan.steps[0].files == ["a.py"]
    assert "Convert this planning note" in fake.chat_requests[-1]["messages"][-1]["content"] or fake.chat_requests[-1]["messages"][-2]["content"]


async def test_review_uses_structured_output(tmp_path: Path, fake: FakeOpenAI):  # noqa: F811
    b, _ = brain(cfg(tmp_path, fake))
    fake.queue(text(json.dumps({"summary": "ok", "comments": [{"path": "a.py", "line": 3, "severity": "high", "body": "bug"}]})))
    res = await b.review("--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n+x = 1\n", None)
    assert res.summary == "ok" and any(c.body == "bug" and c.severity == "high" for c in res.comments)
    assert fake.chat_requests[0]["response_format"]["type"] == "json_schema"


RESULTS = [{"path": f"f{i}.py", "line": 1, "snippet": f"snippet {i}", "score": 1 - i / 10} for i in range(5)]


async def test_llm_reranker_orders_and_keeps_dropped_last():
    async def ask(q: str, listing: str):
        assert "[0] snippet 0" in listing and "[4] snippet 4" in listing
        return RankOut(ranking=[3, 99, 3, 1])  # out-of-range and duplicate ids are ignored

    out, used = await apply_rerank(LlmReranker(ask), "q", [dict(r) for r in RESULTS], 5)
    assert used == "llm" and [r["path"] for r in out] == ["f3.py", "f1.py", "f0.py", "f2.py", "f4.py"]
    out, _ = await apply_rerank(LlmReranker(ask), "q", [dict(r) for r in RESULTS], 2)
    assert [r["path"] for r in out] == ["f3.py", "f1.py"]


async def test_reranker_failure_keeps_fused_order():
    async def boom(q: str, listing: str):
        raise RuntimeError("provider down")

    out, used = await apply_rerank(LlmReranker(boom), "q", [dict(r) for r in RESULTS], 3)
    assert used is None and [r["path"] for r in out] == ["f0.py", "f1.py", "f2.py"]

    async def none(q: str, listing: str):
        return None

    assert (await apply_rerank(LlmReranker(none), "q", [dict(r) for r in RESULTS], 3))[1] is None


async def test_http_reranker_cohere_format():
    seen: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"], seen["auth"], seen["body"] = str(req.url), req.headers["authorization"], json.loads(req.content)
        return httpx.Response(200, json={"results": [{"index": 2, "relevance_score": 0.9}, {"index": 0, "relevance_score": 0.1}, {"index": 1, "relevance_score": 0.5}]})

    rr = HttpReranker("https://rerank.example/v1", "k", "rerank-v3.5", httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    assert await rr.rerank("q", ["a", "b", "c"]) == [2, 1, 0]
    assert seen["url"] == "https://rerank.example/v1/rerank" and seen["auth"] == "Bearer k"
    assert seen["body"]["documents"] == ["a", "b", "c"] and seen["body"]["model"] == "rerank-v3.5"


def test_build_reranker_selection(tmp_path: Path):
    b = object.__new__(ChatModelBrain)
    assert build_reranker(cfg(tmp_path, rerank_provider="none"), b) is None
    assert build_reranker(cfg(tmp_path), b).name == "llm"  # type: ignore[union-attr]
    assert build_reranker(cfg(tmp_path), None) is None
    assert build_reranker(cfg(tmp_path, rerank_base_url="https://x/v1", rerank_api_key="k"), b).name.startswith("http:")  # type: ignore[union-attr]


async def test_hybrid_search_reports_reranker(tmp_path: Path):
    from app.repo.index import RepoIndex

    for n in "abcd":
        (tmp_path / f"m_{n}.py").write_text(f"def func_{n}():\n    return 'value {n}'\n")
    idx = RepoIndex.from_dir(tmp_path)

    async def ask(q: str, listing: str):
        return RankOut(ranking=[1])

    res = await idx.hybrid_search("func value", 3, None, reranker=LlmReranker(ask))
    assert res["reranker"] == "llm" and len(res["results"]) <= 3
    assert "reranker" not in await idx.hybrid_search("func value", 3, None)
