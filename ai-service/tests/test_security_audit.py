"""Security auditor and repo-memory injection."""

from __future__ import annotations

import json

from tests.conftest import index_repo, make_repo

SEV_ORDER = ["critical", "high", "medium", "low", "info"]


async def test_security_audit_finds_issues(client, tmp_path) -> None:
    repo = make_repo(tmp_path / "vuln", {
        "app.py": "import subprocess, yaml, requests\n"
                  'API_KEY = "sk-ant-api03-' + "a" * 40 + '"\n'
                  'subprocess.run("ls " + x, shell=True)\n'
                  "requests.get(u, verify=False)\n"
                  "yaml.load(data)\n",
        "package.json": json.dumps({"dependencies": {"left-pad": "latest", "ok": "^1.0.0"},
                                    "scripts": {"postinstall": "node x.js"}}),
        "requirements.txt": "flask\nrequests==2.31.0\n",
        "Dockerfile": "FROM python:latest\nRUN echo hi\n",
        ".env": "SECRET=1\n",
    })
    await index_repo(client, repo)
    r = await client.post("/repos/repo1/security")
    assert r.status_code == 200, r.text
    body = r.json()
    rules = {f["rule"] for f in body["findings"]}
    assert {"hardcoded-secret", "py-subprocess-shell", "tls-verify-disabled", "unsafe-yaml-load",
            "dep-unpinned", "install-script", "docker-root-user", "docker-latest-tag",
            "committed-env-file"} <= rules
    assert body["grade"] in {"D", "F"} and body["score"] < 60
    assert body["dependencies"] == {"npm": 2, "pip": 2}
    assert "sk-ant-api03" not in json.dumps(body), "secret values must never be echoed"
    sev = [f["severity"] for f in body["findings"]]
    assert sev == sorted(sev, key=SEV_ORDER.index)
    assert "critical" in body["summary"]


async def test_security_audit_clean_repo(client, tmp_path) -> None:
    repo = make_repo(tmp_path / "clean", {"app.py": "def add(a, b):\n    return a + b\n"})
    await index_repo(client, repo)
    body = (await client.post("/repos/repo1/security")).json()
    assert body["score"] == 100 and body["findings"] == []
