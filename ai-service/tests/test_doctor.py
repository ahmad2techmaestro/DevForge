"""Runs `doctor.py` end-to-end against a fake OpenAI-compatible server (no internet, no keys)."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

from tests.fake_openai import FakeOpenAI, text, tool_call

AI = Path(__file__).resolve().parents[1]


def test_doctor_reports_each_layer():
    with FakeOpenAI() as fake:
        fake.queue(
            text("OK"),                                            # 2 chat
            text(json.dumps({"ranking": [1, 0, 2]})),               # 3 structured (json_schema mode)
            tool_call("get_weather", {"city": "Paris"}),            # 4 tool calling
            text(json.dumps({"ranking": [1]})),                     # 6 LLM reranker
        )
        env = {**os.environ, "LLM_PROVIDER": "openai_compatible", "OPENAI_BASE_URL": fake.base_url, "OPENAI_COMPATIBLE_MODEL": "m",
               "OPENAI_API_KEY": "sk-test-secret", "EMBEDDING_PROVIDER": "openai_compatible", "EMBEDDING_BASE_URL": fake.base_url,
               "EMBEDDING_MODEL": "e", "EMBEDDING_API_KEY": "k", "MCP_ALLOW_STDIO": "true", "DOCTOR_OFFLINE": "1", "RERANK_PROVIDER": "llm",
               "GEMINI_API_KEY": "", "GITHUB_TOKEN": ""}
        r = subprocess.run([sys.executable, "doctor.py"], cwd=AI, env=env, capture_output=True, text=True, timeout=120)
    out = re.sub(r"\x1b\[[0-9;]*m", "", r.stdout)
    status = {m.group(2).strip(): m.group(1) for m in re.finditer(r"(PASS|FAIL|skip)\s+(\d+\. .+?)\s{2,}", out)}
    assert status["1. Provider configured"] == "PASS", out
    assert status["2. Chat completion"] == "PASS", out
    assert status["3. Structured output (JSON)"] == "PASS" and "mode=json_schema" in out, out
    assert status["4. Tool calling"] == "PASS", out
    assert status["5. Embeddings (RAG)"] in ("PASS", "FAIL") and "dim=16" in out, out  # fake vectors are random, only the plumbing is checked
    assert status["6. Reranker"] == "PASS" and "backend=llm" in out, out
    assert status["7. MCP (stdio)"] == "PASS", out
    assert "sk-test-secret" not in r.stdout + r.stderr
