from __future__ import annotations

from pathlib import Path

import pytest

from app.repo import symbols as symbols_mod
from app.repo.embeddings import HashEmbedder
from app.repo.index import RepoIndex
from app.repo.intel import is_test_path

REPO = {
    "auth/passwords.py": (
        "import hashlib\n\n\ndef hash_password(pw, salt):\n    return hashlib.sha256((salt + pw).encode()).hexdigest()\n\n\n"
        "def verify_password(pw, salt, expected):\n    return hash_password(pw, salt) == expected\n"
    ),
    "auth/login.py": (
        "from auth.passwords import verify_password\n\n\ndef login(user, pw):\n"
        "    return verify_password(pw, user['salt'], user['hash'])\n"
    ),
    "api/views.py": "from auth.login import login\n\n\ndef signin_view(req):\n    return login(req['user'], req['pw'])\n",
    "billing/invoice.py": "def make_invoice(items):\n    return sum(i['price'] for i in items)\n",
    "tests/test_login.py": "from auth.login import login\n\n\ndef test_login():\n    assert login({'salt': 's', 'hash': 'x'}, 'p') is False\n",
    "web/util.js": "export function slugify(s) { return s.toLowerCase().replace(/ /g, '-'); }\n",
    "web/page.js": "import { slugify } from './util.js';\nexport function title(t) { return slugify(t); }\n",
    "main.go": "package main\n\nfunc helper() int { return 1 }\n\nfunc main() { helper() }\n",
    "Svc.java": "class Svc {\n  int run() { return calc(); }\n  int calc() { return 2; }\n}\n",
}


@pytest.fixture
def index(tmp_path: Path) -> RepoIndex:
    for rel, text in REPO.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    return RepoIndex.from_dir(tmp_path)


def test_symbols_for_each_language(index: RepoIndex) -> None:
    intel = index.intel()
    names = {s["name"] for s in intel.symbols()}
    assert {"hash_password", "verify_password", "login", "slugify", "title", "helper", "main"} <= names
    assert any(n.endswith("calc") for n in names)  # java method
    assert intel.engine in ("tree-sitter", "fallback")
    py = {s["name"]: s for s in intel.symbols("auth/passwords.py")}
    assert py["verify_password"]["line"] == 8


def test_impact_transitive_and_tests(index: RepoIndex) -> None:
    res = index.intel().impact("auth/passwords.py")
    assert "auth/login.py" in res["direct"]
    assert "api/views.py" in res["transitive"]
    assert res["tests"] == ["tests/test_login.py"]
    assert res["risk"] in ("low", "medium", "high")
    assert "billing/invoice.py" not in [*res["direct"], *res["transitive"]]


def test_impact_for_symbol_and_isolated_file(index: RepoIndex) -> None:
    sym = index.intel().impact("auth/passwords.py", "verify_password")
    assert {"path": "auth/login.py", "symbol": "login"} in sym["symbolCallers"]
    lone = index.intel().impact("billing/invoice.py")
    assert lone["direct"] == [] and lone["tests"] == [] and lone["risk"] == "low"


def test_js_import_dependents(index: RepoIndex) -> None:
    assert "web/page.js" in index.intel().impact("web/util.js")["direct"]


def test_callgraph_edges(index: RepoIndex) -> None:
    g = index.intel().callgraph("auth/login.py")
    assert {"from": "auth/login.py::login", "to": "auth/passwords.py::verify_password"} in g["edges"]


def test_test_path_detection() -> None:
    assert is_test_path("tests/test_x.py") and is_test_path("src/a.test.ts") and not is_test_path("src/app.py")


def test_fallback_engine_when_treesitter_missing(index: RepoIndex, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(symbols_mod, "_parser", lambda _k: None)
    from app.repo.intel import CodeIntel

    intel = CodeIntel.build(index)
    assert intel.engine == "fallback"
    assert "auth/login.py" in intel.impact("auth/passwords.py")["direct"]


async def test_hash_embedder_deterministic() -> None:
    e = HashEmbedder()
    a, b = await e.embed(["verify user password"]), await e.embed(["verify user password"])
    assert a == b and abs(sum(x * x for x in a[0]) - 1) < 1e-6


async def test_semantic_ranks_relevant_file_first(index: RepoIndex) -> None:
    res = await index.semantic(HashEmbedder()).search("where do we verify the user's password", "semantic", 3)
    assert res["results"][0]["path"] == "auth/passwords.py"
    assert res["embedder"] .startswith("hash")


async def test_hybrid_fusion_contains_both_signals(index: RepoIndex) -> None:
    res = await index.hybrid_search("slugify title", 5)
    paths = [r["path"] for r in res["results"]]
    assert "web/util.js" in paths or "web/page.js" in paths


async def test_failing_remote_embedder_falls_back(index: RepoIndex) -> None:
    class Broken:
        name = "remote"

        async def embed(self, texts):  # type: ignore[no-untyped-def]
            raise RuntimeError("down")

    res = await index.semantic(Broken()).search("password", "hybrid", 3)  # type: ignore[arg-type]
    assert res["embedder"] .startswith("hash") and res["results"]
