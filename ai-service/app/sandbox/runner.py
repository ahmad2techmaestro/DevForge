"""Test-runner detection (pytest / npm test / node --test) and result parsing."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

from app.sandbox.base import Sandbox

Framework = str  # "pytest" | "npm" | "node:test" | "none"


@dataclass(frozen=True, slots=True)
class TestPlan:
    framework: Framework
    argv: list[str]
    install: list[str] | None = None  # runs in a separate networked step (docker only)

    def display(self) -> str:
        return " ".join(["python" if self.argv[0] == "python" else self.argv[0], *self.argv[1:]])


@dataclass(slots=True)
class TestOutcome:
    passed: int
    failed: int
    total: int
    ok: bool
    output: str
    duration_ms: int
    framework: Framework


def _has_files(root: Path, pattern: str) -> bool:
    skip = {"node_modules", ".git", ".venv", "venv", ".devforge_deps"}
    for _dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip]
        if any(re.search(pattern, f) for f in filenames):
            return True
    return False


def detect(root: Path) -> TestPlan | None:
    pkg = root / "package.json"
    if pkg.exists():
        try:
            scripts = json.loads(pkg.read_text("utf-8")).get("scripts", {})
        except (ValueError, OSError):
            scripts = {}
        test_script = str(scripts.get("test", ""))
        install = ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"]
        if test_script and "no test specified" not in test_script:
            return TestPlan("npm", ["npm", "test", "--silent"], install)
        if _has_files(root, r"\.(test|spec)\.[cm]?[jt]s$"):
            return TestPlan("node:test", ["node", "--test"])
    has_py_tests = (
        (root / "pytest.ini").exists()
        or (root / "conftest.py").exists()
        or _has_files(root, r"^(test_.*|.*_test)\.py$")
    )
    if has_py_tests:
        install = None
        if (root / "requirements.txt").exists():
            install = ["python", "-m", "pip", "install", "--quiet", "--target", ".devforge_deps",
                       "-r", "requirements.txt", "pytest"]  # fmt: skip
        else:
            install = ["python", "-m", "pip", "install", "--quiet", "--target", ".devforge_deps", "pytest"]
        return TestPlan("pytest", ["python", "-m", "pytest", "-q", "-p", "no:cacheprovider", "--color=no"], install)
    return None


def _num(pattern: str, text: str) -> int:
    m = re.search(pattern, text)
    return int(m.group(1)) if m else 0


def parse_counts(output: str, exit_code: int) -> tuple[int, int]:
    """Return (passed, failed) from pytest, node:test (TAP summary) or jest-style output."""
    if re.search(r"(?m)^# pass \d+", output):
        return _num(r"(?m)^# pass (\d+)", output), _num(r"(?m)^# fail (\d+)", output)
    if re.search(r"(?m)^ℹ pass \d+", output):
        return _num(r"(?m)^ℹ pass (\d+)", output), _num(r"(?m)^ℹ fail (\d+)", output)
    if re.search(r"Tests:\s+.*\btotal\b", output):
        return _num(r"(\d+) passed", output), _num(r"(\d+) failed", output)
    passed = _num(r"(\d+) passed", output)
    failed = _num(r"(\d+) failed", output) + _num(r"(\d+) errors?\b", output)
    if passed == 0 and failed == 0 and exit_code != 0:
        failed = 1
    return passed, failed


async def run_tests(
    sandbox: Sandbox, root: Path, plan: TestPlan, timeout: float, *, python_image: str | None = None
) -> TestOutcome:
    prelude = ""
    total_ms = 0
    if sandbox.name == "docker" and plan.install:
        deps = root / ".devforge_deps"
        deps.mkdir(exist_ok=True)
        deps.chmod(0o777)
        if plan.framework == "npm":
            res = await sandbox.run(plan.install + ["--prefix", ".devforge_deps"], root, timeout=timeout, network=True)
        else:
            res = await sandbox.run(plan.install, root, timeout=timeout, network=True)
        total_ms += res.duration_ms
        if res.exit_code != 0:
            prelude = f"[dependency install failed]\n{res.output[-2000:]}\n"
    res = await sandbox.run(plan.argv, root, timeout=timeout, isolate=True)
    output = prelude + res.output
    passed, failed = parse_counts(res.output, res.exit_code)
    ok = res.exit_code == 0 and failed == 0
    return TestOutcome(
        passed=passed, failed=failed, total=passed + failed, ok=ok,
        output=output[-8192:], duration_ms=total_ms + res.duration_ms, framework=plan.framework,
    )  # fmt: skip
