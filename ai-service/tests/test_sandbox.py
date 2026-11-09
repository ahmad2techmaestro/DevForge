from __future__ import annotations

import sys
from pathlib import Path

from app.sandbox.docker_sandbox import DockerSandbox, docker_available
from app.sandbox.runner import detect, parse_counts, run_tests
from app.sandbox.subprocess_sandbox import SubprocessSandbox


def test_docker_command_flags(tmp_path: Path) -> None:
    cmd = DockerSandbox.build_command(tmp_path, "python:3.13-slim", ["python", "-m", "pytest", "-q"])
    s = " ".join(cmd)
    for flag in ("--network none", "--memory 512m", "--cpus 1", "--pids-limit 256", "--read-only",
                 "--tmpfs /tmp", "--security-opt no-new-privileges", "--user 1000:1000",
                 f"{tmp_path.resolve()}:/workspace", "-w /workspace"):  # fmt: skip
        assert flag in s, flag
    assert cmd[:3] == ["docker", "run", "--rm"]
    assert cmd[-5:] == ["python:3.13-slim", "python", "-m", "pytest", "-q"][-5:]
    assert "-e" in cmd and not any("KEY" in c or "TOKEN" in c for c in cmd)


def test_docker_install_step_has_network(tmp_path: Path) -> None:
    cmd = DockerSandbox.build_command(tmp_path, "node:22-slim", ["npm", "install"], network=True)
    assert "--network" in cmd and cmd[cmd.index("--network") + 1] == "bridge"
    assert "--read-only" in cmd  # still locked down otherwise


def test_docker_image_choice() -> None:
    d = DockerSandbox("py", "nd")
    assert d.pick_image(["npm", "test"]) == "nd" and d.pick_image(["python", "-m", "pytest"]) == "py"


async def test_docker_unavailable_here() -> None:
    assert await docker_available(timeout=2.0) is False


async def test_subprocess_env_scrubbed_and_cwd(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-should-not-leak")
    monkeypatch.setenv("INTERNAL_KEY", "leak")
    res = await SubprocessSandbox().run(["sh", "-c", "env; pwd"], tmp_path, timeout=10)
    assert res.exit_code == 0 and "should-not-leak" not in res.output and "INTERNAL_KEY" not in res.output
    assert str(tmp_path) in res.output


async def test_subprocess_timeout_and_output_cap(tmp_path: Path) -> None:
    res = await SubprocessSandbox().run(["sh", "-c", "sleep 30"], tmp_path, timeout=0.5)
    assert res.timed_out and "timed out" in res.output
    big = await SubprocessSandbox().run([sys.executable, "-c", "print('x' * 2_000_000)"], tmp_path, timeout=20)
    assert len(big.output) <= 200_001
    missing = await SubprocessSandbox().run(["definitely-not-a-binary"], tmp_path, timeout=5)
    assert missing.exit_code == 127


async def test_isolate_does_not_touch_workspace(tmp_path: Path) -> None:
    res = await SubprocessSandbox().run(["sh", "-c", "touch created.txt"], tmp_path, timeout=5, isolate=True)
    assert res.exit_code == 0 and not (tmp_path / "created.txt").exists()


def test_parse_counts() -> None:
    assert parse_counts("3 passed, 1 failed in 0.1s", 1) == (3, 1)
    assert parse_counts("5 passed in 0.02s", 0) == (5, 0)
    assert parse_counts("2 failed, 1 passed, 1 error in 1s", 1) == (1, 3)
    assert parse_counts("TAP\n# tests 4\n# pass 3\n# fail 1\n", 1) == (3, 1)
    assert parse_counts("ℹ tests 2\nℹ pass 2\nℹ fail 0\n", 0) == (2, 0)
    assert parse_counts("Tests:       1 failed, 2 passed, 3 total", 1) == (2, 1)
    assert parse_counts("Traceback boom", 2) == (0, 1)


def test_detect_runners(tmp_path: Path) -> None:
    assert detect(tmp_path) is None
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_x.py").write_text("def test_x(): pass\n")
    assert detect(tmp_path).framework == "pytest"  # type: ignore[union-attr]
    js = tmp_path / "js"
    js.mkdir()
    (js / "package.json").write_text('{"scripts":{"test":"node --test"}}')
    p = detect(js)
    assert p and p.framework == "npm" and p.argv[:2] == ["npm", "test"]
    js2 = tmp_path / "js2"
    (js2 / "test").mkdir(parents=True)
    (js2 / "package.json").write_text('{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}')
    (js2 / "test" / "a.test.mjs").write_text("")
    p2 = detect(js2)
    assert p2 and p2.framework == "node:test" and p2.argv == ["node", "--test"]


async def test_run_tests_pass_and_fail(tmp_path: Path) -> None:
    (tmp_path / "test_ok.py").write_text("def test_a():\n    assert 1\n\ndef test_b():\n    assert True\n")
    plan = detect(tmp_path)
    assert plan
    out = await run_tests(SubprocessSandbox(), tmp_path, plan, 60)
    assert out.ok and out.passed == 2 and out.failed == 0 and out.total == 2
    (tmp_path / "test_bad.py").write_text("def test_c():\n    assert 0\n")
    out = await run_tests(SubprocessSandbox(), tmp_path, plan, 60)
    assert not out.ok and out.failed == 1 and out.passed == 2
    assert not (tmp_path / "__pycache__").exists() and not (tmp_path / ".pytest_cache").exists()
