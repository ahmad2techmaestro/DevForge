"""Pydantic models for the contract (CONTRACT.md section 1)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

Severity = Literal["info", "low", "medium", "high", "critical"]
RunKind = Literal["feature", "bugfix", "refactor", "tests", "review", "explain"]
RunStatus = Literal["running", "awaiting_approval", "completed", "failed", "cancelled"]


class Usage(BaseModel):
    inputTokens: int = 0
    outputTokens: int = 0
    costUsd: float = 0.0


class Finding(BaseModel):
    path: str
    line: int
    severity: Severity
    rule: str
    title: str
    detail: str
    suggestion: str | None = None


class Risk(BaseModel):
    score: int
    level: Literal["low", "medium", "high"]
    reasons: list[str] = Field(default_factory=list)


class ReviewComment(BaseModel):
    path: str
    line: int
    severity: Literal["info", "low", "medium", "high"]
    body: str


class DiffFile(BaseModel):
    path: str
    status: Literal["added", "modified", "deleted"]
    additions: int
    deletions: int


class PlanStep(BaseModel):
    id: str
    title: str
    detail: str = ""
    files: list[str] = Field(default_factory=list)


class Approval(BaseModel):
    approvalId: str
    kind: Literal["plan", "changes"]
    summary: str
    payload: dict[str, object] = Field(default_factory=dict)


# ---- requests -------------------------------------------------------------


class IndexRequest(BaseModel):
    repoId: str
    cloneUrl: str | None = None
    localPath: str | None = None
    branch: str | None = None
    token: str | None = None

    @model_validator(mode="after")
    def _exactly_one(self) -> IndexRequest:
        if bool(self.cloneUrl) == bool(self.localPath):
            raise ValueError("exactly one of cloneUrl or localPath is required")
        return self


class SearchRequest(BaseModel):
    query: str
    limit: int = Field(default=20, ge=1, le=100)


class ExplainRequest(BaseModel):
    path: str
    question: str | None = None


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1)


class BugsRequest(BaseModel):
    paths: list[str] | None = None


class ReviewRequest(BaseModel):
    diff: str


class RunTask(BaseModel):
    kind: RunKind
    title: str
    description: str = ""


from app.mcp.client import McpServerConfig  # noqa: E402


class RunOptions(BaseModel):
    autoApprove: bool = False
    maxFixAttempts: int = Field(default=2, ge=0, le=10)


class CreateRunRequest(BaseModel):
    runId: str
    taskId: str
    repoId: str
    task: RunTask
    callbackUrl: str
    options: RunOptions = Field(default_factory=RunOptions)
    # Repo memory: conventions and past feedback the agent should respect (max 30 short notes).
    memory: list[str] = Field(default_factory=list, max_length=30)
    # External MCP servers the agents may call (decrypted by the API; never logged or echoed).
    mcpServers: list[McpServerConfig] = Field(default_factory=list, max_length=8)

    @field_validator("callbackUrl")
    @classmethod
    def _http_url(cls, v: str) -> str:
        if not v.startswith(("http://", "https://")):
            raise ValueError("callbackUrl must be http(s)")
        return v


class ApproveRequest(BaseModel):
    approvalId: str
    decision: Literal["approve", "reject"]
    feedback: str | None = None
    editedPlan: list[PlanStep] | None = None


class CommitRequest(BaseModel):
    branch: str
    message: str
    authorName: str | None = None
    authorEmail: str | None = None


class PushRequest(BaseModel):
    cloneUrl: str
    branch: str
    token: str
