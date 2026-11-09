"""Docker sandbox. Command-line construction is a pure, testable method."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

from app.sandbox.base import OUTPUT_CAP, ExecResult


async def docker_available(timeout: float = 3.0) -> bool:
    """True if a docker daemon answers `docker info` within `timeout` seconds."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker", "info", "--format", "{{.ServerVersion}}",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )  # fmt: skip
    except (FileNotFoundError, PermissionError, NotImplementedError):
        return False
    try:
        return await asyncio.wait_for(proc.wait(), timeout) == 0
    except TimeoutError:
        proc.kill()
        return False


class DockerSandbox:
    name = "docker"

    def __init__(self, python_image: str, node_image: str) -> None:
        self.python_image = python_image
        self.node_image = node_image

    def pick_image(self, argv: list[str]) -> str:
        return self.node_image if argv and argv[0] in ("node", "npm", "npx") else self.python_image

    @staticmethod
    def build_command(
        workspace: Path, image: str, argv: list[str], *, network: bool = False
    ) -> list[str]:
        """Exact flags required by CONTRACT.md; `network=True` is for dependency installs only."""
        return [
            "docker", "run", "--rm",
            "--network", "bridge" if network else "none",
            "--memory", "512m",
            "--cpus", "1",
            "--pids-limit", "256",
            "--read-only",
            "--tmpfs", "/tmp",
            "--security-opt", "no-new-privileges",
            "--user", "1000:1000",
            "-v", f"{workspace.resolve()}:/workspace",
            "-w", "/workspace",
            "-e", "HOME=/tmp",
            "-e", "PYTHONDONTWRITEBYTECODE=1",
            "-e", "PYTHONPATH=/workspace/.devforge_deps:/workspace",
            "-e", "NODE_PATH=/workspace/.devforge_deps/node_modules",
            image, *argv,
        ]  # fmt: skip

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
        cmd = self.build_command(cwd, image or self.pick_image(argv), argv, network=network)
        start = time.monotonic()
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )  # fmt: skip
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
            proc.kill()
            await proc.wait()
        out = b"".join(chunks).decode(errors="replace")
        if timed_out:
            out += f"\n[timed out after {timeout:.0f}s]"
        return ExecResult(proc.returncode or 0, out, int((time.monotonic() - start) * 1000), timed_out)
