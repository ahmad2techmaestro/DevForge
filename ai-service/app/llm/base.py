"""Brain: the LLM-facing operations the service needs. Mock and real providers implement it."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from app.repo.index import RepoIndex
from app.sandbox.base import Sandbox
from app.schemas import ChatMessage, Finding, PlanStep, ReviewComment
from app.types import Emit


@dataclass(slots=True)
class PlanResult:
    summary: str
    steps: list[PlanStep]
    # Spec-first: what must be true when done, and how it will be built.
    requirements: list[str] = field(default_factory=list)
    design: str = ""


@dataclass(slots=True)
class ReviewResult:
    summary: str
    comments: list[ReviewComment] = field(default_factory=list)


@dataclass(slots=True)
class ChatResult:
    answer: str
    citations: list[dict[str, object]]


@dataclass(slots=True)
class WorkContext:
    """Everything an implementer needs to act on a run workspace."""

    workspace: Path
    kind: str
    title: str
    description: str
    plan: list[PlanStep]
    sandbox: Sandbox
    emit: Emit
    feedback: str | None = None  # human feedback after a rejection
    test_output: str | None = None  # set when fixing failing tests


class Brain(Protocol):
    provider: str

    async def plan(
        self, index: RepoIndex, kind: str, title: str, description: str, feedback: str | None,
        emit: Emit,
    ) -> PlanResult: ...

    async def implement(self, ctx: WorkContext) -> str: ...

    async def analyze(self, index: RepoIndex, kind: str, title: str, description: str, emit: Emit) -> str:
        """Analysis-only runs (review / explain): returns a markdown summary."""
        ...

    async def review(self, diff: str, index: RepoIndex | None) -> ReviewResult: ...

    async def chat(self, index: RepoIndex, messages: list[ChatMessage]) -> ChatResult: ...

    async def explain(self, index: RepoIndex, path: str, question: str | None) -> str: ...

    async def find_bugs(self, index: RepoIndex, paths: list[str]) -> list[Finding]:
        """LLM bug pass (empty for mock; static rules are applied by the caller)."""
        ...
