"""Optional Semgrep integration: used only when the `semgrep` binary is on PATH."""

from __future__ import annotations

import asyncio
import json
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from app.repo.gitops import _env
from app.schemas import Finding, Severity

TIMEOUT = 120.0
OUTPUT_CAP = 20_000_000  # bytes of JSON read from semgrep
MAX_FINDINGS = 300

_SEV: dict[str, Severity] = {"ERROR": "high", "WARNING": "medium", "INFO": "low"}


@dataclass(slots=True)
class SemgrepResult:
    status: str  # missing | ok | failed | timeout
    findings: list[Finding] = field(default_factory=list)
    error: str | None = None

    def engine_info(self) -> dict[str, object]:
        out: dict[str, object] = {"status": self.status, "findings": len(self.findings)}
        if self.error:
            out["error"] = self.error
        return out


def semgrep_available() -> bool:
    return shutil.which("semgrep") is not None


def map_results(data: dict[str, object]) -> list[Finding]:
    """Convert semgrep --json output to Findings. Matched source text is never copied."""
    out: list[Finding] = []
    for r in data.get("results") or []:  # type: ignore[attr-defined]
        if not isinstance(r, dict):
            continue
        extra = r.get("extra") or {}
        meta = extra.get("metadata") or {}
        rule_id = str(r.get("check_id") or "semgrep")
        short = rule_id.rsplit(".", 1)[-1]
        path = str(r.get("path") or "").replace("\\", "/").removeprefix("./")
        line = int(((r.get("start") or {}).get("line")) or 1)
        sev = _SEV.get(str(extra.get("severity", "")).upper(), "medium")
        cwe = meta.get("cwe")
        cwe_s = ", ".join(cwe) if isinstance(cwe, list) else (str(cwe) if cwe else "")
        message = str(extra.get("message") or short).strip()
        detail = message[:500] + (f" ({cwe_s})" if cwe_s else "")
        fix = extra.get("fix")
        out.append(Finding(
            path=path, line=line, severity=sev, rule=f"semgrep:{short}"[:120], title=f"Semgrep: {short}"[:160],
            detail=detail, suggestion=(f"Suggested fix: {str(fix)[:200]}" if fix else None),
        ))  # fmt: skip
        if len(out) >= MAX_FINDINGS:
            break
    return out


async def _read_capped(stream: asyncio.StreamReader, cap: int) -> tuple[bytes, bool]:
    buf = bytearray()
    while True:
        chunk = await stream.read(65536)
        if not chunk:
            return bytes(buf), False
        buf += chunk
        if len(buf) > cap:
            return bytes(buf[:cap]), True


async def run_semgrep(
    root: Path, *, command: list[str] | None = None, timeout: float = TIMEOUT, output_cap: int = OUTPUT_CAP,
) -> SemgrepResult:
    """Run `semgrep --config auto --json` over `root`. Silent `missing` status when it is not installed.

    `command` replaces the leading executable (tests inject a fake); the semgrep arguments are always appended.
    """
    if command is None:
        exe = shutil.which("semgrep")
        if exe is None:
            return SemgrepResult("missing")
        command = [exe]
    argv = [*command, "--config", "auto", "--json", "--quiet", "--disable-version-check", "."]
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, cwd=root, env=_env(), stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )  # fmt: skip
    except (OSError, ValueError) as exc:
        return SemgrepResult("missing" if isinstance(exc, FileNotFoundError) else "failed", error=type(exc).__name__)
    assert proc.stdout is not None
    try:
        raw, truncated = await asyncio.wait_for(_read_capped(proc.stdout, output_cap), timeout)
        if truncated:
            proc.kill()
        await asyncio.wait_for(proc.wait(), 10)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        return SemgrepResult("timeout", error=f"semgrep exceeded {timeout:.0f}s")
    if truncated:
        return SemgrepResult("failed", error="semgrep output exceeded size cap")
    try:
        data = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        return SemgrepResult("failed", error=f"semgrep exited {proc.returncode} without JSON output")
    if not isinstance(data, dict):
        return SemgrepResult("failed", error="unexpected semgrep output")
    return SemgrepResult("ok", map_results(data))
