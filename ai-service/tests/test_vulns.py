"""OSV dependency scanning, manifest parsing, semgrep mapping and secret detection (no real network)."""

from __future__ import annotations

import json
import sys
import textwrap
from pathlib import Path

import httpx

from app.repo import vulns
from app.repo.security_audit import scan_secrets, shannon_entropy
from app.repo.semgrep import map_results, run_semgrep
from app.repo.vulns import Dependency, cvss3_score, parse_manifests, scan_dependencies
from tests.conftest import index_repo, make_repo

GHSA = {
    "id": "GHSA-aaaa-bbbb-cccc", "summary": "Prototype pollution", "aliases": ["CVE-2024-0001"],
    "database_specific": {"severity": "HIGH"},
    "affected": [{"package": {"name": "lodash", "ecosystem": "npm"},
                  "ranges": [{"type": "SEMVER", "events": [{"introduced": "0"}, {"fixed": "4.17.21"}]}]}],
    "references": [{"type": "WEB", "url": "https://example.test/web"},
                   {"type": "ADVISORY", "url": "https://github.com/advisories/GHSA-aaaa-bbbb-cccc"}],
}
PYSEC = {
    "id": "PYSEC-2023-1", "summary": "Header injection",
    "severity": [{"type": "CVSS_V3", "score": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}],
    "affected": [{"package": {"name": "requests", "ecosystem": "PyPI"},
                  "ranges": [{"type": "ECOSYSTEM", "events": [{"fixed": "2.32.0"}]}]}],
}


def fake_osv(calls: list[httpx.Request], paginate: bool = False) -> httpx.MockTransport:
    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        if req.url.path == "/v1/querybatch":
            body = json.loads(req.content)
            results = []
            for q in body["queries"]:
                name = q["package"]["name"]
                if name == "lodash" and not q.get("page_token"):
                    r: dict[str, object] = {"vulns": [{"id": GHSA["id"]}]}
                    if paginate:
                        r["next_page_token"] = "t2"
                    results.append(r)
                elif name == "lodash" and q.get("page_token") == "t2":
                    results.append({"vulns": [{"id": "GHSA-page-two-xxxx"}]})
                elif name == "requests":
                    results.append({"vulns": [{"id": PYSEC["id"]}]})
                else:
                    results.append({})
            return httpx.Response(200, json={"results": results})
        vid = req.url.path.rsplit("/", 1)[-1]
        known = {GHSA["id"]: GHSA, PYSEC["id"]: PYSEC}
        return httpx.Response(200, json=known[vid]) if vid in known else httpx.Response(404)

    return httpx.MockTransport(handler)


FILES = [
    ("requirements.txt", "requests==2.19.0\nflask\n# comment\nclick==8.0.0 ; python_version>'3'\n"),
    ("package.json", json.dumps({"dependencies": {"lodash": "4.17.0", "left": "^1.0.0"}})),
]


async def test_osv_batch_findings(monkeypatch) -> None:
    calls: list[httpx.Request] = []
    async with httpx.AsyncClient(transport=fake_osv(calls)) as c:
        res = await scan_dependencies(FILES, "https://osv.test", client=c)
    assert res.status == "ok" and res.packages == 3 and res.vulnerable == 2
    by_id = {a["id"]: a for a in res.advisories}
    assert by_id["GHSA-aaaa-bbbb-cccc"]["severity"] == "high"
    assert by_id["GHSA-aaaa-bbbb-cccc"]["fixedIn"] == ["4.17.21"]
    assert by_id["GHSA-aaaa-bbbb-cccc"]["url"] == "https://github.com/advisories/GHSA-aaaa-bbbb-cccc"
    assert by_id["PYSEC-2023-1"]["severity"] == "critical"  # CVSS 9.8 from the vector
    assert by_id["PYSEC-2023-1"]["url"].startswith("https://osv.dev/vulnerability/")
    f = next(x for x in res.findings if x.rule == "vuln-GHSA-aaaa-bbbb-cccc")
    assert f.path == "package.json" and "Fixed in: 4.17.21" in f.detail and f.suggestion
    batch = [c for c in calls if c.url.path == "/v1/querybatch"]
    assert len(batch) == 1
    sent = batch[0].content.decode()
    assert "flask" not in sent and "comment" not in sent  # unpinned + file text never sent
    assert set(json.loads(sent)["queries"][0]) == {"package", "version"}


async def test_osv_pagination_and_clean() -> None:
    calls: list[httpx.Request] = []
    async with httpx.AsyncClient(transport=fake_osv(calls, paginate=True)) as c:
        res = await scan_dependencies([FILES[1]], "https://osv.test", client=c)
    ids = {a["id"] for a in res.advisories}
    assert ids == {"GHSA-aaaa-bbbb-cccc", "GHSA-page-two-xxxx"}
    assert res.status == "partial"  # second advisory's detail 404s: severity defaults, scan still reported
    clean = [("requirements.txt", "click==8.0.0\n")]
    async with httpx.AsyncClient(transport=fake_osv([])) as c:
        res = await scan_dependencies(clean, "https://osv.test", client=c)
    assert res.status == "ok" and res.findings == []
    assert (await scan_dependencies([], "https://osv.test")).status == "ok"


async def test_osv_offline_degrades(monkeypatch) -> None:
    monkeypatch.setattr(vulns, "BACKOFF", 0.0)
    attempts = []

    def boom(req: httpx.Request) -> httpx.Response:
        attempts.append(1)
        raise httpx.ConnectError("no route", request=req)

    async with httpx.AsyncClient(transport=httpx.MockTransport(boom)) as c:
        res = await scan_dependencies(FILES, "https://osv.test", client=c)
    assert res.status == "unreachable" and res.findings == [] and res.packages == 3
    assert len(attempts) == vulns.RETRIES + 1

    n = []

    def flaky(req: httpx.Request) -> httpx.Response:
        n.append(1)
        if len(n) == 1:
            return httpx.Response(503)
        return httpx.Response(200, json={"results": [{}, {}, {}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(flaky)) as c:
        res = await scan_dependencies(FILES, "https://osv.test", client=c)
    assert res.status == "ok" and len(n) == 2  # retried once after the 503

    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(403))) as c:
        res = await scan_dependencies(FILES, "https://osv.test", client=c)
    assert res.status == "unreachable"
    assert (await scan_dependencies(FILES, "")).status == "skipped"


async def test_security_route_reports_osv_unreachable(client, tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(vulns, "BACKOFF", 0.0)
    monkeypatch.setattr(vulns, "RETRIES", 0)
    repo = make_repo(tmp_path / "r", {"requirements.txt": "requests==2.19.0\n"})
    await index_repo(client, repo)
    body = (await client.post("/repos/repo1/security")).json()
    assert body["engines"]["osv"]["status"] in ("unreachable", "ok", "partial")
    assert set(body["tools"]) == {"semgrep", "osv"} and body["tools"]["semgrep"] in ("missing", "ok", "failed")
    assert body["dependencies"] == {"pip": 1}
    assert {"score", "grade", "counts", "findings", "summary", "usage"} <= set(body)


async def test_security_route_with_fake_osv(settings, tmp_path, monkeypatch) -> None:
    from tests.conftest import running

    monkeypatch.setattr(vulns, "make_client", lambda: httpx.AsyncClient(transport=fake_osv([])))
    repo = make_repo(tmp_path / "r", {"package.json": json.dumps({"dependencies": {"lodash": "4.17.0"}})})
    async with running(settings.model_copy(update={"osv_url": "https://osv.test"})) as (c, _):
        await index_repo(c, repo)
        body = (await c.post("/repos/repo1/security")).json()
    assert body["engines"]["osv"]["status"] == "ok"
    assert any(f["rule"] == "vuln-GHSA-aaaa-bbbb-cccc" and f["severity"] == "high" for f in body["findings"])
    assert body["advisories"][0]["fixedIn"] == ["4.17.21"]


# ---- manifest parsing -------------------------------------------------------------------------------


def test_parse_requirements_and_pyproject() -> None:
    deps = parse_manifests([
        ("a/requirements-dev.txt", "Django_Rest==3.9.0\nrequests[security]==2.0.1 # x\n-r base.txt\nflask>=2\n"),
        ("pyproject.toml", textwrap.dedent('''
            [project]
            dependencies = ["httpx==0.27.0", "pydantic>=2", "pyyaml[extra]==6.0.1; python_version>'3'"]
            [project.optional-dependencies]
            dev = ["pytest==8.0.0"]
            [tool.poetry.dependencies]
            python = "^3.12"
            jinja2 = "3.1.2"
            rich = {version = "13.0.0"}
            ''')),
    ])
    got = {(d.ecosystem, d.name, d.version) for d in deps}
    assert got == {
        ("PyPI", "django-rest", "3.9.0"), ("PyPI", "requests", "2.0.1"), ("PyPI", "httpx", "0.27.0"),
        ("PyPI", "pyyaml", "6.0.1"), ("PyPI", "pytest", "8.0.0"), ("PyPI", "jinja2", "3.1.2"),
        ("PyPI", "rich", "13.0.0"),
    }
    assert next(d for d in deps if d.name == "django-rest").line == 1


def test_parse_npm_manifest_and_lock() -> None:
    lock_v3 = {"lockfileVersion": 3, "packages": {
        "": {"name": "x"}, "node_modules/a": {"version": "1.2.3"},
        "node_modules/a/node_modules/b": {"version": "0.1.0"}, "node_modules/@s/c": {"version": "2.0.0"},
        "node_modules/ln": {"link": True, "version": "9.9.9"},
    }}
    lock_v1 = {"lockfileVersion": 1, "dependencies": {"d": {"version": "3.0.0", "dependencies": {"e": {"version": "1.0.0"}}}}}
    deps = parse_manifests([
        ("package.json", json.dumps({"dependencies": {"a": "1.2.3", "r": "^1.0.0", "t": "~2.0.0", "x": "=4.5.6"}})),
        ("package-lock.json", json.dumps(lock_v3)),
        ("sub/package-lock.json", json.dumps(lock_v1)),
    ])
    got = {(d.name, d.version) for d in deps}
    assert got == {("a", "1.2.3"), ("x", "4.5.6"), ("b", "0.1.0"), ("@s/c", "2.0.0"), ("d", "3.0.0"), ("e", "1.0.0")}
    assert len([d for d in deps if d.name == "a"]) == 1  # package.json + lock deduplicated
    assert parse_manifests([("package.json", "{not json")]) == []


def test_parse_go_gemfile_pom() -> None:
    go = 'module m\n\ngo 1.22\n\nrequire github.com/a/b v1.2.3\n\nrequire (\n\tgolang.org/x/net v0.1.0 // indirect\n\tgithub.com/c/d v2.0.0+incompatible\n)\n'
    gem = "GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (2.2.3)\n      rails (>= 1)\n    nokogiri (1.13.0-x86_64-linux)\n\nPLATFORMS\n  ruby\n"
    pom = """<project><dependencies>
      <!-- <dependency><groupId>no</groupId><artifactId>no</artifactId><version>1</version></dependency> -->
      <dependency><groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId><version>2.14.1</version></dependency>
      <dependency><groupId>g</groupId><artifactId>a</artifactId><version>${v}</version></dependency>
    </dependencies></project>"""
    deps = parse_manifests([("go.mod", go), ("Gemfile.lock", gem), ("pom.xml", pom)])
    assert {(d.ecosystem, d.name, d.version) for d in deps} == {
        ("Go", "github.com/a/b", "1.2.3"), ("Go", "golang.org/x/net", "0.1.0"),
        ("Go", "github.com/c/d", "2.0.0+incompatible"), ("RubyGems", "rack", "2.2.3"),
        ("RubyGems", "nokogiri", "1.13.0-x86_64-linux"),
        ("Maven", "org.apache.logging.log4j:log4j-core", "2.14.1"),
    }
    assert Dependency("Go", "a", "1", "go.mod").key == ("Go", "a", "1")


def test_cvss3_scores() -> None:
    assert cvss3_score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H") == 9.8
    assert cvss3_score("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N") == 6.1
    assert cvss3_score("CVSS:4.0/AV:N") is None


# ---- semgrep ----------------------------------------------------------------------------------------


def test_semgrep_mapping() -> None:
    data = {"results": [{
        "check_id": "python.lang.security.audit.eval-detected", "path": "./app\\x.py", "start": {"line": 7},
        "extra": {"severity": "ERROR", "message": "eval is dangerous", "lines": "SECRET_CODE_SHOULD_NOT_APPEAR",
                  "metadata": {"cwe": ["CWE-95"]}, "fix": "ast.literal_eval(x)"},
    }, {"check_id": "x.y", "path": "b.js", "start": {"line": 1}, "extra": {"severity": "INFO", "message": "m"}}]}
    f = map_results(data)
    assert f[0].path == "app/x.py" and f[0].line == 7 and f[0].severity == "high"
    assert f[0].rule == "semgrep:eval-detected" and "CWE-95" in f[0].detail and f[0].suggestion
    assert "SECRET_CODE" not in f[0].model_dump_json() and f[1].severity == "low"


async def test_semgrep_runner(tmp_path: Path) -> None:
    ok = tmp_path / "fake_ok.py"
    ok.write_text("import json\nprint(json.dumps({'results': [{'check_id': 'a.b', 'path': 'x.py', "
                  "'start': {'line': 3}, 'extra': {'severity': 'WARNING', 'message': 'm'}}]}))\n")
    res = await run_semgrep(tmp_path, command=[sys.executable, str(ok)])
    assert res.status == "ok" and res.findings[0].severity == "medium"
    big = tmp_path / "fake_big.py"
    big.write_text("print('x' * 5000)\n")
    assert (await run_semgrep(tmp_path, command=[sys.executable, str(big)], output_cap=100)).status == "failed"
    slow = tmp_path / "fake_slow.py"
    slow.write_text("import time\ntime.sleep(30)\n")
    assert (await run_semgrep(tmp_path, command=[sys.executable, str(slow)], timeout=0.5)).status == "timeout"
    junk = tmp_path / "fake_junk.py"
    junk.write_text("print('not json')\n")
    assert (await run_semgrep(tmp_path, command=[sys.executable, str(junk)])).status == "failed"


async def test_semgrep_missing_is_silent(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("app.repo.semgrep.shutil.which", lambda _: None)
    res = await run_semgrep(tmp_path)
    assert res.status == "missing" and res.findings == []


# ---- secrets ----------------------------------------------------------------------------------------


def test_secret_patterns_redacted() -> None:
    samples = {
        "secret-aws-access-key": "key = 'AKIA" + "ABCDEFGHIJKLMNOP" + "'",
        "secret-github-token": "t = 'ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8" + "'",
        "secret-google-api-key": "k: AIza" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q",
        "secret-slack-token": "x = 'xoxb-1234567890-abcdefghij'",
        "secret-stripe-key": "s = 'sk_live_" + "abcdefghijklmnop1234" + "'",
        "secret-private-key": "-----BEGIN RSA PRIVATE KEY-----",
        "secret-jwt": "tok = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'",
        "secret-openai-key": "k = 'sk-proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8" + "'",
    }
    for rule, line in samples.items():
        found = scan_secrets("src/cfg.py", line + "\n")
        assert [f.rule for f in found] == [rule], (rule, found)
        dumped = found[0].model_dump_json()
        assert line.split("'")[1 if "'" in line else 0][:14] not in dumped or rule == "secret-private-key"
    assert scan_secrets("package-lock.json", "AKIAABCDEFGHIJKLMNOP") == []


def test_entropy_detection_and_false_positives() -> None:
    rand = "q8Zr3KpV7xLm2NwT9bYc5HdJ1sFg6AeU"
    hit = scan_secrets("cfg.py", f'DB_PASSWORD = "{rand}"\n')
    assert hit and hit[0].rule == "secret-high-entropy" and rand not in hit[0].model_dump_json()
    assert shannon_entropy(rand) > 4.0 > shannon_entropy("aaaaaaaaaaaaaaaaaaaa")
    for ok in ['API_KEY = "your-api-key-goes-here-1234"', 'TOKEN = "aaaaaaaaaaaaaaaaaaaaaaaa"',
               'name = "q8Zr3KpV7xLm2NwT9bYc5HdJ1sFg6AeU"', 'SECRET = "https://example.com/some/long/path/x"',
               'password = os.environ["PASSWORD_VALUE_LONG_ENOUGH"]']:
        assert scan_secrets("cfg.py", ok + "\n") == [], ok
