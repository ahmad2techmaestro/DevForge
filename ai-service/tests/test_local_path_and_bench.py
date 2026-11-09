"""Local folder handling for "Connect repository" and the benchmark runner endpoints."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app.config import Settings
from app.errors import ApiError
from app.repo.index import resolve_local_path
from tests.conftest import KEY, index_repo, running


def test_accepts_quoted_and_file_url_paths(tmp_path: Path) -> None:
    folder = tmp_path / "My Project"
    folder.mkdir()
    assert resolve_local_path(f'"{folder}"') == folder
    assert resolve_local_path(f"  '{folder}'  ") == folder
    assert resolve_local_path(folder.as_uri()) == folder


@pytest.mark.parametrize(
    ("raw", "hint"),
    [
        ("", "full path"),
        ("https://github.com/someone/WeatherX", "Clone URL"),
        ("github.com/someone/WeatherX", "Clone URL"),
        ("WeatherX", "relative"),
    ],
)
def test_bad_input_gets_a_specific_message(raw: str, hint: str) -> None:
    with pytest.raises(ApiError) as err:
        resolve_local_path(raw)
    assert hint.lower() in err.value.message.lower()


def test_missing_folder_and_file(tmp_path: Path) -> None:
    with pytest.raises(ApiError) as err:
        resolve_local_path(str(tmp_path / "nope"))
    assert "Folder not found" in err.value.message
    f = tmp_path / "a.txt"
    f.write_text("x")
    with pytest.raises(ApiError) as err2:
        resolve_local_path(str(f))
    assert "is a file" in err2.value.message


async def test_index_endpoint_reports_the_reason(client, tmp_path: Path) -> None:
    r = await client.post("/repos/index", json={"repoId": "r1", "localPath": str(tmp_path / "missing")})
    assert r.status_code == 400
    assert "Folder not found" in r.text


async def test_quoted_path_indexes(client, py_repo: Path) -> None:
    data = await index_repo(client, Path(f'"{py_repo}"'))
    assert data["fileCount"]


async def test_bench_refuses_the_demo_model(client) -> None:
    r = await client.post("/eval/run", json={})
    assert r.status_code == 409
    assert "real model" in r.text
    status = (await client.get("/eval/status")).json()
    assert status["status"] == "idle"


async def test_bench_runs_with_a_real_provider_setting(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The endpoint starts a run, reports progress and returns to done (the subprocess is replaced by a stub)."""
    import app.routes.llm as llm

    class Proc:
        returncode = 0

        def __init__(self) -> None:
            lines = [b"[bench] t1 ...\n", b"[bench]   -> solved (1s, 10 tok)\n", b"[bench] t2 ...\n", b"[bench]   -> failed (1s, 10 tok)\n"]
            self.stdout = self._gen(lines)

        @staticmethod
        async def _gen(lines: list[bytes]):  # type: ignore[no-untyped-def]
            for ln in lines:
                yield ln

        async def wait(self) -> int:
            return 0

    async def fake_exec(*_a: object, **_k: object) -> Proc:
        return Proc()

    monkeypatch.setattr(llm.asyncio, "create_subprocess_exec", fake_exec)
    settings = Settings(internal_key=KEY, llm_provider="groq", groq_api_key="k", workdir=tmp_path / "d", sandbox="subprocess")
    async with running(settings) as (c, app):
        r = await c.post("/eval/run", json={"limit": 2})
        assert r.status_code == 202 and r.json()["status"] == "running"
        assert (await c.post("/eval/run", json={})).status_code in (202, 409)
        await app.state.bench_task
        s = (await c.get("/eval/status")).json()
        assert s["status"] == "done" and s["done"] == 2 and s["total"] == 2


def test_no_stale_benchmark_result_is_shipped() -> None:
    results = Path(__file__).resolve().parents[1] / "eval" / "results"
    assert not (results / "latest.json").exists(), "a mock result would show a misleading 0% score on first run"
    assert asyncio  # keep the import used
