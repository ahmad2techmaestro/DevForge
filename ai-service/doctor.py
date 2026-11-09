"""Live health check: runs REAL calls with your keys and tells you exactly what works.

    npm run doctor            (reads the root .env)

Nothing here prints a key. Each check is independent; exit code is 1 if any check FAILS (skips are fine).
Paste the output when something fails: it names the layer, the HTTP status and the fix.
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))


def load_env() -> None:
    f = ROOT / ".env"
    if not f.exists():
        return
    for raw in f.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip().strip('"').strip("'")
        if v:
            os.environ.setdefault(k.strip(), v)


load_env()

from langchain_core.messages import HumanMessage, SystemMessage  # noqa: E402

from app.config import Settings  # noqa: E402
from app.errors import ApiError  # noqa: E402
from app.llm.provider import build_model, build_reranker, default_brain_factory  # noqa: E402
from app.llm.structured import RankOut, structured  # noqa: E402
from app.llm.usage import UsageMeter  # noqa: E402

S = Settings.from_env()
RESULTS: list[tuple[str, str, str]] = []
ICON = {"PASS": "\033[32m✓ PASS\033[0m", "FAIL": "\033[31m✗ FAIL\033[0m", "SKIP": "\033[33m- skip\033[0m"}


def record(name: str, status: str, detail: str) -> None:
    RESULTS.append((name, status, detail))
    print(f"  {ICON[status]}  {name:<28} {detail}", flush=True)


def explain(e: BaseException) -> str:
    msg = e.message if isinstance(e, ApiError) else f"{type(e).__name__}: {e}"
    for env in ("GEMINI_API_KEY", "GROQ_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "EMBEDDING_API_KEY", "RERANK_API_KEY"):
        v = os.environ.get(env)
        if v:
            msg = msg.replace(v, "***")
    return msg[:260]


async def check(name: str, fn):  # type: ignore[no-untyped-def]
    t = time.perf_counter()
    try:
        status, detail = await asyncio.wait_for(fn(), 90)
    except Exception as e:  # noqa: BLE001
        status, detail = "FAIL", explain(e)
    record(name, status, f"{detail}  ({time.perf_counter() - t:.1f}s)" if status != "SKIP" else detail)


async def main() -> int:
    print(f"\nDevForge doctor · provider={S.llm_provider} model={S.model}\n")
    real = S.llm_provider != "mock"
    meter = UsageMeter(S.model)
    model = None

    async def cfg():  # type: ignore[no-untyped-def]
        nonlocal model
        if not real:
            return "SKIP", "LLM_PROVIDER=mock. Set LLM_PROVIDER=gemini and GEMINI_API_KEY in .env (free key: aistudio.google.com)"
        model = build_model(S)
        return "PASS", f"{S.llm_provider} configured"

    await check("1. Provider configured", cfg)

    async def chat():  # type: ignore[no-untyped-def]
        if model is None:
            return "SKIP", "needs a configured provider"
        from app.llm.loop import ainvoke

        out = await ainvoke(model, [HumanMessage("Reply with exactly: OK")], meter, provider=S.llm_provider)
        return ("PASS", f"model answered {out.strip()[:30]!r}, {meter.total_tokens} tokens") if out.strip() else ("FAIL", "empty answer")

    await check("2. Chat completion", chat)

    async def struct():  # type: ignore[no-untyped-def]
        if model is None:
            return "SKIP", "needs a configured provider"
        out, mode = await structured(model, [SystemMessage("Rank by relevance to 'sort a list'."), HumanMessage("[0] cook rice\n[1] sorted(xs)\n[2] paint a wall")],
                                     RankOut, meter, provider=S.llm_provider)
        if out is None:
            return "FAIL", "model did not return valid JSON in any mode (try a stronger model)"
        ok = out.ranking[:1] == [1]
        return ("PASS" if ok else "FAIL"), f"mode={mode}, ranking={out.ranking}" + ("" if ok else " (wrong order)")

    await check("3. Structured output (JSON)", struct)

    async def tools():  # type: ignore[no-untyped-def]
        if model is None:
            return "SKIP", "needs a configured provider"
        from app.llm.loop import call_model

        schema = {"type": "function", "function": {"name": "get_weather", "description": "Weather for a city", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}
        resp = await call_model(model.bind_tools([schema]), [HumanMessage("What is the weather in Paris? Use the tool.")], meter, provider=S.llm_provider)
        calls = getattr(resp, "tool_calls", [])
        return ("PASS", f"tool call {calls[0]['name']}({calls[0]['args']})") if calls else ("FAIL", "model ignored the tool (agents need tool calling; pick a model that supports it)")

    await check("4. Tool calling", tools)

    async def embed():  # type: ignore[no-untyped-def]
        from app.repo.embeddings import build_embedder

        emb = build_embedder(S)
        if emb.name.startswith("hash"):
            return "SKIP", f"using offline {emb.name}; set GEMINI_API_KEY or OPENAI_API_KEY for real embeddings"
        v = await emb.embed(["def sort_list(xs): return sorted(xs)", "function that orders items", "recipe for pasta"])
        cos = lambda a, b: sum(x * y for x, y in zip(a, b, strict=True)) / ((sum(x * x for x in a) ** 0.5) * (sum(y * y for y in b) ** 0.5))  # noqa: E731
        good, bad = cos(v[0], v[1]), cos(v[0], v[2])
        return ("PASS" if good > bad else "FAIL"), f"{emb.name}, dim={len(v[0])}, related={good:.2f} vs unrelated={bad:.2f}"

    await check("5. Embeddings (RAG)", embed)

    async def rerank():  # type: ignore[no-untyped-def]
        from app.repo.rerank import apply_rerank

        brain = default_brain_factory(S)(meter) if real else None
        rr = build_reranker(S, brain)  # type: ignore[arg-type]
        if rr is None:
            return "SKIP", "no reranker available (needs a real LLM or RERANK_BASE_URL + RERANK_API_KEY)"
        cands = [{"snippet": "def bake_cake(): ..."}, {"snippet": "def hash_password(pw): bcrypt.hashpw(pw)"}, {"snippet": "class Logger: ..."}]
        out, used = await apply_rerank(rr, "where is the password hashed?", cands, 3)
        return ("PASS" if used and "hash_password" in out[0]["snippet"] else "FAIL"), f"backend={used}, top={out[0]['snippet'][:30]!r}"

    await check("6. Reranker", rerank)

    async def mcp():  # type: ignore[no-untyped-def]
        from app.mcp.client import McpClient, McpPolicy, McpServerConfig

        if not S.mcp_allow_stdio:
            return "SKIP", "MCP_ALLOW_STDIO is not true (npm run dev enables it)"
        with tempfile.TemporaryDirectory() as d:
            Path(d, "a.py").write_text("def add(a, b):\n    return a + b\n")
            env = {"PYTHONPATH": str(Path(__file__).resolve().parent), "LLM_PROVIDER": "mock"}
            c = McpClient(McpServerConfig(name="self", command=sys.executable, args=["-m", "app.mcp.server", "--repo", d], env=env), McpPolicy(allow_stdio=True), timeout=60)
            await c.connect()
            try:
                names = [t["name"] for t in await c.list_tools()]
                ok, text = await c.call_tool("search_code", {"query": "add numbers"})
            finally:
                await c.close()
        return ("PASS" if ok and "a.py" in text else "FAIL"), f"DevForge MCP server over stdio: {len(names)} tools, search works"

    await check("7. MCP (stdio)", mcp)

    custom = os.environ.get("DOCTOR_MCP_URL")

    async def mcp_http():  # type: ignore[no-untyped-def]
        if not custom:
            return "SKIP", "set DOCTOR_MCP_URL=https://your-server/mcp (and optional DOCTOR_MCP_AUTH='Bearer ...') to test a remote server"
        from app.mcp.client import McpPolicy, McpServerConfig, inspect_server

        headers = {"Authorization": os.environ["DOCTOR_MCP_AUTH"]} if os.environ.get("DOCTOR_MCP_AUTH") else {}
        res = await inspect_server(McpServerConfig(name="remote", transport="http", url=custom, headers=headers), McpPolicy(allow_private_http=S.mcp_allow_private))
        return "PASS", f"{res['server'].get('name', 'server')}: {len(res['tools'])} tools"

    await check("8. MCP (remote URL)", mcp_http)

    async def osv():  # type: ignore[no-untyped-def]
        if os.environ.get("DOCTOR_OFFLINE"):
            return "SKIP", "offline mode"
        import httpx

        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.post(S.osv_url.rstrip("/") + "/v1/query", json={"package": {"name": "lodash", "ecosystem": "npm"}, "version": "4.17.15"})
        r.raise_for_status()
        n = len(r.json().get("vulns", []))
        return ("PASS" if n else "FAIL"), f"OSV.dev reachable, {n} known vulnerabilities for lodash 4.17.15"

    await check("9. Vulnerability DB (OSV)", osv)

    async def gh():  # type: ignore[no-untyped-def]
        if os.environ.get("DOCTOR_OFFLINE"):
            return "SKIP", "offline mode"
        import httpx

        tok = os.environ.get("GITHUB_TOKEN")
        h = {"Authorization": f"Bearer {tok}"} if tok else {}
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.get("https://api.github.com/user" if tok else "https://api.github.com/rate_limit", headers=h)
        if r.status_code == 401:
            return "FAIL", "GITHUB_TOKEN rejected (401): create a new token with repo scope"
        r.raise_for_status()
        return "PASS", (f"token OK for @{r.json().get('login')}" if tok else "GitHub reachable (set GITHUB_TOKEN to also test your token)")

    await check("10. GitHub API", gh)

    fails = [r for r in RESULTS if r[1] == "FAIL"]
    passed = sum(1 for r in RESULTS if r[1] == "PASS")
    print(f"\n{passed} passed, {len(fails)} failed, {len(RESULTS) - passed - len(fails)} skipped · LLM spend this check: ${meter.cost:.4f}\n")
    if fails:
        print("Fix hints: 401 = wrong key · 404 = wrong model name · 429 = free-tier limit, wait or use another provider · 'tool call' FAIL = pick a model that supports tools.\n")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
