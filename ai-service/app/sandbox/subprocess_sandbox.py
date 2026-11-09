"""Fallback sandbox: scrubbed-env subprocess with wall-clock timeout and output cap."""

from __future__ import annotations

import asyncio
import contextlib
import os
import shutil
import signal
import sys
import tempfile
import time
from pathlib import Path

from app.sandbox.base import OUTPUT_CAP, ExecResult

_COPY_IGNORE = shutil.ignore_patterns(".git", "__pycache__", ".pytest_cache", ".devforge_deps")


def scrubbed_env(home: str) -> dict[str, str]:
    """Only PATH survives from the parent environment; no API keys or tokens leak."""
    env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": home,
        "LANG": "C.UTF-8",
        "CI": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "NO_COLOR": "1",
    }
    if os.name == "nt":  # Python and Node cannot start on Windows without these
        for k in ("SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"):
            if k in os.environ:
                env[k] = os.environ[k]
        env["USERPROFILE"] = home
    return env


class SubprocessSandbox:
    name = "subprocess"

    async def run(
        self,
        argv: list[str],
        cwd: Path,
        *,
        timeout: float,
        network: bool = False,
        isolate: bool = False,
        image: str | None = None,
    ) -> ExecResult:
        if argv and argv[0] == "python":
            argv = [sys.executable, *argv[1:]]
        with tempfile.TemporaryDirectory(prefix="devforge-sbx-") as tmp:
            work = cwd
            if isolate:
                work = Path(tmp) / "ws"
                await asyncio.to_thread(shutil.copytree, cwd, work, ignore=_COPY_IGNORE, symlinks=True)
            return await self._exec(argv, work, timeout, tmp)

    async def _exec(self, argv: list[str], cwd: Path, timeout: float, home: str) -> ExecResult:
        start = time.monotonic()
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                cwd=cwd,
                env=scrubbed_env(home),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                start_new_session=True,
            )
        except (FileNotFoundError, PermissionError) as e:
            return ExecResult(127, f"command not found: {argv[0]} ({e})", 0)
        assert proc.stdout is not None
        chunks: list[bytes] = []

        async def drain() -> None:
            size = 0
            while data := await proc.stdout.read(65536):  # type: ignore[union-attr]
                if size < OUTPUT_CAP:
                    chunks.append(data[: OUTPUT_CAP - size])
                    size += len(data)

        timed_out = False
        try:
            await asyncio.wait_for(asyncio.gather(drain(), proc.wait()), timeout)
        except TimeoutError:
            timed_out = True
            _kill_group(proc.pid)
            await proc.wait()
        except asyncio.CancelledError:
            _kill_group(proc.pid)
            raise
        output = b"".join(chunks).decode(errors="replace")
        if timed_out:
            output += f"\n[timed out after {timeout:.0f}s]"
        return ExecResult(
            proc.returncode if proc.returncode is not None else -1,
            output,
            int((time.monotonic() - start) * 1000),
            timed_out,
        )


def _kill_group(pid: int) -> None:
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(pid, signal.SIGKILL)
