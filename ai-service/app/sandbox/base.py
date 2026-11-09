"""Sandbox interface and result type."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

OUTPUT_CAP = 200_000


@dataclass(slots=True)
class ExecResult:
    exit_code: int
    output: str
    duration_ms: int
    timed_out: bool = False


class Sandbox(Protocol):
    name: str

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
        """Run argv in `cwd`. `isolate` runs against a throwaway copy of the workspace."""
        ...
