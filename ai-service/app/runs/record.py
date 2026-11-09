"""Per-run mutable record (status, pending approval, persisted metadata)."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from pathlib import Path

from app.runs.events import EventLog
from app.schemas import Approval, CreateRunRequest

TERMINAL = ("completed", "failed", "cancelled")


@dataclass
class RunRecord:
    run_id: str
    dir: Path
    req: CreateRunRequest | None = None
    log: EventLog | None = None
    status: str = "running"
    pending: Approval | None = None
    base_commit: str = ""
    changes_approved: bool = False
    committed_branch: str | None = None
    task: asyncio.Task[None] | None = None
    decisions: asyncio.Queue[dict[str, object]] = field(default_factory=asyncio.Queue)

    @property
    def workspace(self) -> Path:
        return self.dir / "repo"

    @property
    def meta_path(self) -> Path:
        return self.dir / "meta.json"

    def save(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        self.meta_path.write_text(
            json.dumps({
                "status": self.status, "baseCommit": self.base_commit,
                "changesApproved": self.changes_approved, "committedBranch": self.committed_branch,
            }),
            "utf-8",
        )  # fmt: skip

    def load_meta(self) -> None:
        if not self.meta_path.exists():
            return
        meta = json.loads(self.meta_path.read_text("utf-8"))
        self.status = meta.get("status", self.status)
        self.base_commit = meta.get("baseCommit", "")
        self.changes_approved = bool(meta.get("changesApproved"))
        self.committed_branch = meta.get("committedBranch")
