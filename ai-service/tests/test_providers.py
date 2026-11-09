"""End-to-end tests of the real ChatOpenAI client against the local fake OpenAI-compatible server."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest
from langchain_openai import ChatOpenAI

from app.config import Settings
from app.errors import ApiError
from app.llm import loop, observability
from app.llm.base import WorkContext
from app.llm.loop import call_model, extract_json
from app.llm.provider import (
    BASE_URLS,
    ChatModelBrain,
    build_model,
    check_provider,
    default_brain_factory,
)
from app.llm.usage import UsageMeter
from app.repo.index import RepoIndex
from app.sandbox.subprocess_sandbox import SubprocessSandbox
from app.schemas import PlanStep
from tests.conftest import KEY, H, make_repo, running
from tests.fake_openai import EMBED_DIM, FakeOpenAI, embed, error, text, tool_call


@pytest.fixture
def fake() -> Iterator[FakeOpenAI]:
    with FakeOpenAI() as f:
        yield f


@pytest.fixture(autouse=True)
def fast_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    async def no_sleep(_: float) -> None:
        return None

    monkeypatch.setattr(loop, "_sleep", no_sleep)


def cfg(tmp_path: Path, fake: FakeOpenAI | None = None, **kw: object) -> Settings:
    base: dict[str, object] = {
        "internal_key": KEY, "workdir": tmp_path / "data", "sandbox": "subprocess",
        "llm_provider": "openai_compatible", "openai_compatible_model": "strong-1",
    }
    if fake is not None:
        base["openai_base_url"] = fake.base_url
    base.update(kw)
    return Settings(**base)  # type: ignore[arg-type]


def brain(settings: Settings, meter: UsageMeter | None = None) -> tuple[ChatModelBrain, UsageMeter]:
    m = meter or UsageMeter(settings.model)
    b = default_brain_factory(settings)(m)
    assert isinstance(b, ChatModelBrain)
    return b, m


async def emit(*_: object) -> None:
    return None


# ---- wiring ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("provider", "extra", "url_part"),
    [
        ("gemini", {"gemini_api_key": "g-key-123456"}, "generativelanguage.googleapis.com/v1beta/openai"),
        ("groq", {"groq_api_key": "gsk_123456789"}, "api.groq.com/openai/v1"),
        ("openrouter", {"openrouter_api_key": "or-key-123456"}, "openrouter.ai/api/v1"),
        ("ollama", {}, "localhost:11434/v1"),
        ("openai", {"openai_api_key": "sk-123456789"}, "api.openai.com"),
        ("openai_compatible", {"openai_base_url": "http://h:1/v1", "openai_compatible_model": "m"}, "h:1/v1"),
    ],
)
def test_build_model_wires_base_url(tmp_path: Path, provider: str, extra: dict[str, object], url_part: str) -> None:
    m = build_model(cfg(tmp_path, llm_provider=provider, **extra))
    assert isinstance(m, ChatOpenAI)
    assert url_part in str(m.openai_api_base or m.client._client.base_url)  # type: ignore[union-attr]
    assert m.max_retries == 0


def test_base_urls_table() -> None:
    assert BASE_URLS["gemini"] == "https://generativelanguage.googleapis.com/v1beta/openai/"
    assert BASE_URLS["groq"] == "https://api.groq.com/openai/v1"
    assert BASE_URLS["openrouter"] == "https://openrouter.ai/api/v1"
    assert BASE_URLS["ollama"] == "http://localhost:11434/v1"


def test_ollama_base_url_override(tmp_path: Path) -> None:
    m = build_model(cfg(tmp_path, llm_provider="ollama", openai_base_url="http://box:9/v1"))
    assert isinstance(m, ChatOpenAI) and m.openai_api_base == "http://box:9/v1"


@pytest.mark.parametrize(
    ("provider", "env"),
    [("anthropic", "ANTHROPIC_API_KEY"), ("openai", "OPENAI_API_KEY"), ("gemini", "GEMINI_API_KEY"),
     ("groq", "GROQ_API_KEY"), ("openrouter", "OPENROUTER_API_KEY"),
     ("openai_compatible", "OPENAI_BASE_URL")],
)
def test_missing_config_names_env_var(tmp_path: Path, provider: str, env: str) -> None:
    with pytest.raises(ApiError) as ei:
        build_model(cfg(tmp_path, llm_provider=provider, openai_compatible_model="m"))
    assert ei.value.status == 503 and ei.value.code == "provider_not_configured" and env in ei.value.message


def test_openai_compatible_requires_model(tmp_path: Path) -> None:
    with pytest.raises(ApiError, match="OPENAI_COMPATIBLE_MODEL"):
        build_model(cfg(tmp_path, openai_base_url="http://x/v1", openai_compatible_model=""))


@pytest.mark.parametrize("provider", ["gemini", "groq", "openrouter"])
async def test_hosted_providers_send_key_and_model(
    tmp_path: Path, fake: FakeOpenAI, monkeypatch: pytest.MonkeyPatch, provider: str
) -> None:
    # Redirect the fixed public base URL to the fake, keep everything else real.
    monkeypatch.setitem(BASE_URLS, provider, fake.base_url)
    s = cfg(tmp_path, llm_provider=provider, **{f"{provider}_api_key": "the-key-123456"})
    b, _ = brain(s)
    fake.queue(text("hi there"))
    res = await b.explain(_index(tmp_path), "a.py", None)
    assert res == "hi there"
    rec = fake.requests[0]
    assert rec.headers["authorization"] == "Bearer the-key-123456"
    assert rec.body["model"] == s.model


def _index(tmp_path: Path, files: dict[str, str] | None = None) -> RepoIndex:
    root = make_repo(tmp_path / "repo", files or {"a.py": "def f():\n    return 1\n", "README.md": "# hi\n"})
    return RepoIndex.from_dir(root)


# ---- tool loop end to end ----------------------------------------------------------------------


async def test_plan_tool_loop(tmp_path: Path, fake: FakeOpenAI) -> None:
    s = cfg(tmp_path, fake)
    b, meter = brain(s)
    idx = _index(tmp_path)
    fake.queue(
        tool_call("read_file", {"path": "a.py"}),
        text('Here you go:\n```json\n{"summary": "Do it", "steps": [{"title": "Edit f", "detail": "d", "files": ["a.py"]}]}\n```'),
    )
    plan = await b.plan(idx, "feature", "T", "desc", None, emit)
    assert plan.summary == "Do it" and plan.steps[0].files == ["a.py"]
    first, second = fake.chat_requests
    names = {t["function"]["name"] for t in first["tools"]}
    assert names == {"list_files", "read_file", "search_code"}  # plan is read-only
    assert second["messages"][-1]["role"] == "tool" and "def f" in second["messages"][-1]["content"]
    assert meter.input_tokens == 200 and meter.output_tokens == 40


async def test_implement_tool_loop_writes_file(tmp_path: Path, fake: FakeOpenAI) -> None:
    s = cfg(tmp_path, fake)
    b, meter = brain(s)
    ws = tmp_path / "ws"
    ws.mkdir()
    fake.queue(
        tool_call("write_file", {"path": "pkg/new.py", "content": "X = 42\n"}),
        text("Created pkg/new.py."),
    )
    ctx = WorkContext(
        workspace=ws, kind="feature", title="T", description="d",
        plan=[PlanStep(id="s1", title="make", detail="", files=["pkg/new.py"])],
        sandbox=SubprocessSandbox(), emit=emit,
    )
    out = await b.implement(ctx)
    assert out == "Created pkg/new.py."
    assert (ws / "pkg" / "new.py").read_text() == "X = 42\n"
    tool_msg = fake.chat_requests[1]["messages"][-1]
    assert tool_msg["role"] == "tool" and tool_msg["tool_call_id"].startswith("call_")
    assert {t["function"]["name"] for t in fake.chat_requests[0]["tools"]} >= {"write_file", "edit_file", "run_tests"}
    assert meter.total_tokens == 240


# ---- resilience --------------------------------------------------------------------------------


async def test_retry_on_429_then_success(tmp_path: Path, fake: FakeOpenAI, monkeypatch: pytest.MonkeyPatch) -> None:
    delays: list[float] = []

    async def rec(d: float) -> None:
        delays.append(d)

    monkeypatch.setattr(loop, "_sleep", rec)
    b, _ = brain(cfg(tmp_path, fake))
    fake.queue(error(429, retry_after=2), error(503), text("finally"))
    assert await b.explain(_index(tmp_path), "a.py", None) == "finally"
    assert len(fake.chat_requests) == 3
    assert delays[0] == 2.0  # Retry-After honoured
    assert delays[1] == loop.RETRY_BASE_DELAY * 2  # exponential backoff for the 2nd attempt


async def test_retries_exhausted_maps_to_503(tmp_path: Path, fake: FakeOpenAI) -> None:
    b, _ = brain(cfg(tmp_path, fake))
    fake.queue(*[error(429) for _ in range(loop.MAX_RETRIES + 1)])
    with pytest.raises(ApiError) as ei:
        await b.explain(_index(tmp_path), "a.py", None)
    assert ei.value.status == 503 and ei.value.code == "provider_rate_limited"
    assert len(fake.chat_requests) == loop.MAX_RETRIES + 1


@pytest.mark.parametrize("status", [401, 403])
async def test_auth_error_maps_and_does_not_retry_or_leak_key(tmp_path: Path, fake: FakeOpenAI, status: int) -> None:
    secret = "sk-supersecretkey-123456"
    s = cfg(tmp_path, fake, llm_provider="openai", openai_api_key=secret, openai_model="gpt-4.1")
    b, _ = brain(s)
    fake.queue(error(status))
    with pytest.raises(ApiError) as ei:
        await b.explain(_index(tmp_path), "a.py", None)
    e = ei.value
    assert e.status == 502 and e.code == "provider_auth_failed"
    assert "openai" in e.message and "OPENAI_API_KEY" in e.message and secret not in e.message
    assert len(fake.chat_requests) == 1


async def test_wrong_key_against_server_that_checks_keys(tmp_path: Path, fake: FakeOpenAI) -> None:
    fake.expected_key = "right"
    b, _ = brain(cfg(tmp_path, fake, openai_api_key="wrong-key-123456"))
    with pytest.raises(ApiError) as ei:
        await b.explain(_index(tmp_path), "a.py", None)
    assert ei.value.code == "provider_auth_failed"


async def test_client_error_is_provider_error_with_scrubbed_text() -> None:
    class Boom(Exception):
        status_code = 400

    class M:
        async def ainvoke(self, _: object) -> None:
            raise Boom("bad request Bearer abcdef123456 sk-abcdefghijk")

    with pytest.raises(ApiError) as ei:
        await call_model(M(), [], UsageMeter("m"), provider="groq")
    assert ei.value.code == "provider_error"
    assert "abcdef123456" not in ei.value.message and "sk-abcdefghijk" not in ei.value.message


async def test_timeout_is_retried() -> None:
    calls = 0

    class M:
        async def ainvoke(self, _: object) -> object:
            nonlocal calls
            calls += 1
            if calls < 3:
                raise httpx.ReadTimeout("slow")
            from langchain_core.messages import AIMessage

            return AIMessage("ok")

    resp = await call_model(M(), [], UsageMeter("m"), provider="ollama")
    assert resp.content == "ok" and calls == 3


# ---- routing + usage -----------------------------------------------------------------------------


async def test_fast_vs_strong_routing_and_cost_attribution(tmp_path: Path, fake: FakeOpenAI) -> None:
    s = cfg(tmp_path, fake, llm_provider="openai", openai_api_key="sk-test-123456", openai_model="gpt-4.1",
            llm_fast_model="gpt-4.1-mini")
    meter = UsageMeter(s.model)
    b, _ = brain(s, meter)
    idx = _index(tmp_path)
    # fast ops
    fake.queue(text("explained"), text("answered"), text('{"findings": []}'))
    await b.explain(idx, "a.py", None)
    from app.schemas import ChatMessage

    await b.chat(idx, [ChatMessage(role="user", content="what is f")])
    await b.find_bugs(idx, ["a.py"])
    # strong ops
    fake.queue(text('{"summary": "s", "comments": []}'), text("# analysis"),
               text('{"summary": "p", "steps": [{"title": "x"}]}'))
    await b.review("diff --git a/a b/a\n", idx)
    await b.analyze(idx, "review", "t", "d", emit)
    await b.plan(idx, "feature", "t", "d", None, emit)
    assert fake.models_seen == ["gpt-4.1-mini"] * 3 + ["gpt-4.1"] * 3
    assert meter.by_model == {"gpt-4.1-mini": (300, 60), "gpt-4.1": (300, 60)}
    expected = (300 * 0.4 + 60 * 1.6 + 300 * 2.0 + 60 * 8.0) / 1_000_000
    assert meter.snapshot().costUsd == pytest.approx(expected, abs=1e-6)


async def test_no_fast_model_uses_strong_for_everything(tmp_path: Path, fake: FakeOpenAI) -> None:
    b, _ = brain(cfg(tmp_path, fake))
    await b.explain(_index(tmp_path), "a.py", None)
    assert fake.models_seen == ["strong-1"]


def test_unknown_model_costs_zero_and_meter_back_compat() -> None:
    m = UsageMeter("some-local-model")
    m.add(1000, 1000)
    assert m.snapshot().costUsd == 0.0 and m.total_tokens == 2000
    m.add(1_000_000, 0, model="claude-sonnet-4-5")
    assert m.snapshot().costUsd == pytest.approx(3.0)


# ---- self check, route, tracing, embeddings, json --------------------------------------------------


async def test_check_provider_ok_and_error(tmp_path: Path, fake: FakeOpenAI) -> None:
    ok = await check_provider(cfg(tmp_path, fake))
    assert ok == {"ok": True, "provider": "openai_compatible", "model": "strong-1"}
    body = fake.chat_requests[0]
    assert 1 in (body.get("max_tokens"), body.get("max_completion_tokens"))
    fake.queue(error(401))
    bad = await check_provider(cfg(tmp_path, fake, openai_api_key="sk-leaky-key-123456"))
    assert bad["ok"] is False and "provider_auth_failed" in str(bad["error"])
    assert "sk-leaky" not in str(bad)
    unconfigured = await check_provider(cfg(tmp_path, llm_provider="groq"))
    assert unconfigured["ok"] is False and "GROQ_API_KEY" in str(unconfigured["error"])
    assert (await check_provider(cfg(tmp_path, llm_provider="mock")))["ok"] is True


async def test_llm_check_route_requires_auth(tmp_path: Path, fake: FakeOpenAI) -> None:
    async with running(cfg(tmp_path, fake)) as (c, app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agent") as anon:
            assert (await anon.get("/llm/check")).status_code == 401
        r = await c.get("/llm/check", headers=H)
        assert r.status_code == 200 and r.json()["ok"] is True and r.json()["provider"] == "openai_compatible"


def test_observability_noop_and_never_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    observability.reset()
    observability.record_llm_call(provider="p", model="m", input_tokens=1, output_tokens=1, latency_s=0.1, cost_usd=0)
    assert observability.configure(cfg(tmp_path)) is False  # no endpoint
    # Unreachable endpoint with deps missing or present must not raise.
    observability.configure(cfg(tmp_path, otlp_endpoint="http://127.0.0.1:1"))
    observability.record_llm_call(provider="p", model="m", input_tokens=1, output_tokens=1, latency_s=0.1, cost_usd=0)

    class Spy:
        spans: list[dict[str, object]] = []

        def start_span(self, name: str, **kw: object) -> Spy:
            self.spans.append({"name": name, **kw})
            return self

        def set_attribute(self, *a: object) -> None: ...

        def end(self, **kw: object) -> None: ...

    spy = Spy()
    monkeypatch.setattr(observability, "_tracer", spy)
    observability.record_llm_call(provider="groq", model="llama", input_tokens=3, output_tokens=4, latency_s=0.5, cost_usd=0)
    assert spy.spans[0]["attributes"]["gen_ai.usage.input_tokens"] == 3  # type: ignore[index]

    class Broken:
        def start_span(self, *a: object, **k: object) -> None:
            raise RuntimeError("boom")

    monkeypatch.setattr(observability, "_tracer", Broken())
    observability.record_llm_call(provider="p", model="m", input_tokens=1, output_tokens=1, latency_s=0.1, cost_usd=0)
    observability.reset()


async def test_fake_embeddings_deterministic(fake: FakeOpenAI) -> None:
    async with httpx.AsyncClient() as c:
        r = await c.post(f"{fake.base_url}/embeddings", json={"model": "e", "input": ["a", "b", "a"]})
    vecs = [d["embedding"] for d in r.json()["data"]]
    assert len(vecs[0]) == EMBED_DIM and vecs[0] == vecs[2] != vecs[1] and vecs[0] == embed("a")


def test_extract_json_tolerant() -> None:
    assert extract_json('Sure! {"a": 1} hope that helps') == {"a": 1}
    assert extract_json('```json\n{"a": {"b": 2}}\n```') == {"a": {"b": 2}}
    assert extract_json('{"a": 1}\n\nAlso {"b": 2}') == {"a": 1}
    assert extract_json("no json here") is None
