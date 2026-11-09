from __future__ import annotations

import httpx

from tests.conftest import KEY, index_repo


async def test_health_is_public(settings, monkeypatch) -> None:
    from tests.conftest import running

    async def no_docker(*_a, **_k) -> bool:
        return False

    monkeypatch.setattr("app.main.docker_available", no_docker)  # do not depend on the runner having Docker
    async with running(settings) as (_, app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://a") as anon:
            r = await anon.get("/health")
    body = r.json()
    assert r.status_code == 200
    assert body["status"] == "ok" and body["provider"] == "mock" and body["sandbox"] == "subprocess"
    assert body["dockerAvailable"] is False


async def test_auth_required(settings) -> None:
    from tests.conftest import running

    async with running(settings) as (_, app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://a") as anon:
            for method, url in [("GET", "/repos/x/tree"), ("POST", "/runs"), ("GET", "/runs/x"), ("DELETE", "/repos/x")]:
                r = await anon.request(method, url)
                assert r.status_code == 401, (method, url)
                assert r.json()["error"]["code"] == "unauthorized"
            bad = await anon.get("/repos/x/tree", headers={"X-Internal-Key": "nope"})
            assert bad.status_code == 401
            ok = await anon.get("/repos/x/tree", headers={"X-Internal-Key": KEY})
            assert ok.status_code == 404
            assert ok.json()["error"]["code"] == "repo_not_found"


async def test_index_tree_file_search(client, py_repo) -> None:
    info = await index_repo(client, py_repo)
    assert info["fileCount"] == 4  # README + 3 py; node_modules and png ignored
    assert info["languages"]["Python"]["files"] == 3  # type: ignore[index]
    assert len(str(info["commit"])) == 40 and info["branch"] == "main"

    tree = (await client.get("/repos/repo1/tree")).json()["files"]
    paths = {f["path"] for f in tree}
    assert "calc/ops.py" in paths and not any("node_modules" in p or p.endswith(".png") for p in paths)

    f = (await client.get("/repos/repo1/file", params={"path": "calc/ops.py"})).json()
    assert f["language"] == "Python" and "def add" in f["content"] and f["truncated"] is False
    assert (await client.get("/repos/repo1/file", params={"path": "../etc/passwd"})).status_code in (400, 404)
    assert (await client.get("/repos/repo1/file", params={"path": "nope.py"})).status_code == 404

    res = (await client.post("/repos/repo1/search", json={"query": "multiply numbers"})).json()["results"]
    assert res[0]["path"] == "calc/ops.py" and res[0]["score"] > 0


async def test_index_validation_and_delete(client, py_repo) -> None:
    r = await client.post("/repos/index", json={"repoId": "x"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "validation_error"
    r = await client.post("/repos/index", json={"repoId": "../evil", "localPath": str(py_repo)})
    assert r.status_code == 400
    r = await client.post("/repos/index", json={"repoId": "x", "cloneUrl": "https://user:pw@github.com/a/b.git"})
    assert r.status_code == 400
    await index_repo(client, py_repo)
    assert (await client.delete("/repos/repo1")).json() == {"deleted": True}
    assert (await client.get("/repos/repo1/tree")).status_code == 404


async def test_health_graph_bugs_chat_explain_review(client, tmp_path) -> None:
    from tests.conftest import PY_FILES, make_repo

    files = dict(PY_FILES)
    files["calc/bad.py"] = (
        "import subprocess\n\n\ndef run(x, acc=[]):\n    try:\n        eval(x)\n    except:\n        pass\n"
        "    if x == None:\n        return 1\n        print('dead')\n    subprocess.run(x, shell=True)\n"
        "    cur.execute(\"SELECT * FROM t WHERE id=%s\" % x)\n"
    )
    files["calc/cfg.py"] = "AWS = 'AKIAABCDEFGHIJKLMNOP'\n"
    files["web/app.js"] = "const a = require('./util');\nif (a == 1) { console.log(a); }\neval('1');\n"
    files["web/util.js"] = "module.exports = 1;\n"
    repo = make_repo(tmp_path / "bugs", files)
    await index_repo(client, repo, "b")

    health = (await client.get("/repos/b/health")).json()
    assert 0 <= health["score"] <= 100 and health["grade"] in "ABCDF"
    assert health["metrics"]["secretsFound"] >= 1 and health["metrics"]["testRatio"] == 0
    assert any(f["rule"] == "hardcoded-secret" for f in health["findings"])
    assert "AKIAABCDEFGHIJKLMNOP" not in str(health)  # values never echoed

    g = (await client.get("/repos/b/graph")).json()
    edges = {(e["source"], e["target"]) for e in g["edges"]}
    assert ("calc/text.py", "calc/ops.py") in edges and ("web/app.js", "web/util.js") in edges
    assert all("degree" in n for n in g["nodes"])

    findings = (await client.post("/repos/b/bugs", json={})).json()["findings"]
    rules = {f["rule"] for f in findings}
    assert {"py-bare-except", "py-mutable-default", "py-eval-exec", "py-eq-none", "py-unreachable-code",
            "py-subprocess-shell", "sql-string-format", "js-loose-equality", "js-console-log", "js-eval",
            "hardcoded-secret"} <= rules  # fmt: skip
    only = (await client.post("/repos/b/bugs", json={"paths": ["calc/ops.py"]})).json()["findings"]
    assert only == []

    chat = (await client.post("/repos/b/chat", json={"messages": [{"role": "user", "content": "where is multiply defined?"}]})).json()
    assert chat["citations"][0]["path"] == "calc/ops.py" and "calc/ops.py" in chat["answer"]
    assert chat["usage"]["costUsd"] == 0

    ex = (await client.post("/repos/b/explain", json={"path": "calc/text.py"})).json()
    assert "shout" in ex["explanation"] and "calc/ops.py" in ex["explanation"]

    diff = "diff --git a/auth/login.py b/auth/login.py\nnew file mode 100644\n--- /dev/null\n+++ b/auth/login.py\n@@ -0,0 +1,3 @@\n+def f(x):\n+    eval(x)\n+    return 1\n"
    rev = (await client.post("/repos/b/review", json={"diff": diff})).json()
    assert rev["risk"]["score"] > 0 and any("auth" in r for r in rev["risk"]["reasons"])
    assert any(c["path"] == "auth/login.py" and c["line"] == 2 for c in rev["comments"])
