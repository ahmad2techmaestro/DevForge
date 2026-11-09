"""Environment-driven settings and the model pricing table."""

from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

# USD per 1M tokens: (input, output). Matched by longest model-name prefix.
PRICING: dict[str, tuple[float, float]] = {
    "claude-opus": (15.0, 75.0),
    "claude-sonnet": (3.0, 15.0),
    "claude-haiku": (1.0, 5.0),
    "gpt-4.1-mini": (0.4, 1.6),
    "gpt-4.1-nano": (0.1, 0.4),
    "gpt-4.1": (2.0, 8.0),
    "gpt-4o-mini": (0.15, 0.6),
    "gpt-4o": (2.5, 10.0),
    "o4-mini": (1.1, 4.4),
    "gemini-2.5-flash-lite": (0.1, 0.4),
    "gemini-2.5-flash": (0.3, 2.5),
    "gemini-2.5-pro": (1.25, 10.0),
    "llama": (0.0, 0.0),  # free/open models via Groq/Ollama are treated as free
}


def cost_usd(model: str, input_tokens: int, output_tokens: int) -> float:
    """Cost of a call; unknown models (and `mock`) cost 0."""
    matches = [p for p in PRICING if model.startswith(p)]
    if not matches:
        return 0.0
    price_in, price_out = PRICING[max(matches, key=len)]
    return (input_tokens * price_in + output_tokens * price_out) / 1_000_000


def _truthy(v: str) -> bool:
    return v.strip().lower() in ("1", "true", "yes", "on")


class Settings(BaseModel):
    internal_key: str = "dev-internal-key"
    # mock | anthropic | openai | gemini | groq | openrouter | ollama | openai_compatible
    llm_provider: Literal[
        "anthropic", "openai", "gemini", "groq", "openrouter", "ollama", "openai_compatible", "mock"
    ] = "mock"
    anthropic_api_key: str | None = None
    openai_api_key: str | None = None
    gemini_api_key: str | None = None
    groq_api_key: str | None = None
    openrouter_api_key: str | None = None
    anthropic_model: str = "claude-sonnet-4-5"
    openai_model: str = "gpt-4.1"
    gemini_model: str = "gemini-2.5-flash"
    groq_model: str = "llama-3.3-70b-versatile"
    openrouter_model: str = "openai/gpt-4.1-mini"
    ollama_model: str = "qwen2.5-coder:7b"
    # Generic OpenAI-compatible endpoint (also overrides the base URL of openai/ollama when set).
    openai_base_url: str | None = None
    openai_compatible_model: str = ""
    # Model routing: cheap model for classify/chat/explain, strong model for plan/implement/review.
    llm_fast_model: str | None = None
    # Embeddings for semantic search. auto = provider that has a key, else offline hashing vectors.
    embedding_provider: Literal["auto", "hash", "openai", "gemini", "openai_compatible", "ollama"] = "auto"
    embedding_model: str | None = None
    embedding_base_url: str | None = None
    embedding_api_key: str | None = None
    # Optional observability (Langfuse-compatible OTLP). Empty = disabled.
    otlp_endpoint: str | None = None
    osv_url: str = "https://api.osv.dev"
    # MCP: stdio servers run commands on this host, so they are off unless explicitly enabled.
    # Reranking: auto = Cohere-compatible API if configured, else the LLM, none = off.
    rerank_provider: str = "auto"
    rerank_base_url: str | None = None
    rerank_api_key: str | None = None
    rerank_model: str = "rerank-v3.5"
    mcp_allow_stdio: bool = False
    mcp_allow_private: bool = False
    workdir: Path = Path("./data")
    sandbox: Literal["docker", "subprocess", "auto"] = "auto"
    docker_python_image: str = "python:3.13-slim"
    docker_node_image: str = "node:22-slim"
    max_iterations: int = 25
    max_tokens_per_run: int = 500_000
    command_timeout: float = 120.0
    callback_retries: int = 3
    callback_backoff: float = 0.5

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> Settings:
        e = dict(os.environ if env is None else env)
        raw: dict[str, object] = {}

        def pick(field: str, key: str, cast: Callable[[str], object] = str) -> None:
            if e.get(key):
                raw[field] = cast(e[key])

        pick("internal_key", "INTERNAL_KEY")
        pick("llm_provider", "LLM_PROVIDER")
        pick("anthropic_api_key", "ANTHROPIC_API_KEY")
        pick("openai_api_key", "OPENAI_API_KEY")
        pick("gemini_api_key", "GEMINI_API_KEY")
        if "gemini_api_key" not in raw:
            pick("gemini_api_key", "GOOGLE_API_KEY")
        pick("groq_api_key", "GROQ_API_KEY")
        pick("openrouter_api_key", "OPENROUTER_API_KEY")
        pick("gemini_model", "GEMINI_MODEL")
        pick("groq_model", "GROQ_MODEL")
        pick("openrouter_model", "OPENROUTER_MODEL")
        pick("ollama_model", "OLLAMA_MODEL")
        pick("openai_base_url", "OPENAI_BASE_URL")
        pick("openai_compatible_model", "OPENAI_COMPATIBLE_MODEL")
        pick("llm_fast_model", "LLM_FAST_MODEL")
        pick("embedding_provider", "EMBEDDING_PROVIDER")
        pick("embedding_model", "EMBEDDING_MODEL")
        pick("embedding_base_url", "EMBEDDING_BASE_URL")
        pick("embedding_api_key", "EMBEDDING_API_KEY")
        pick("otlp_endpoint", "OTEL_EXPORTER_OTLP_ENDPOINT")
        pick("osv_url", "OSV_URL")
        pick("rerank_provider", "RERANK_PROVIDER")
        pick("rerank_base_url", "RERANK_BASE_URL")
        pick("rerank_api_key", "RERANK_API_KEY")
        pick("rerank_model", "RERANK_MODEL")
        pick("mcp_allow_stdio", "MCP_ALLOW_STDIO", _truthy)
        pick("mcp_allow_private", "MCP_ALLOW_PRIVATE", _truthy)
        pick("anthropic_model", "ANTHROPIC_MODEL")
        pick("openai_model", "OPENAI_MODEL")
        pick("workdir", "WORKDIR", Path)
        pick("sandbox", "SANDBOX")
        pick("docker_python_image", "DOCKER_PYTHON_IMAGE")
        pick("docker_node_image", "DOCKER_NODE_IMAGE")
        pick("max_iterations", "MAX_AGENT_ITERATIONS", int)
        pick("max_tokens_per_run", "MAX_TOKENS_PER_RUN", int)
        pick("command_timeout", "COMMAND_TIMEOUT_SECONDS", float)
        return cls(**raw)

    @property
    def model(self) -> str:
        if self.llm_provider == "anthropic":
            return self.anthropic_model
        by_provider = {
            "openai": self.openai_model, "gemini": self.gemini_model, "groq": self.groq_model,
            "openrouter": self.openrouter_model, "ollama": self.ollama_model,
            "openai_compatible": self.openai_compatible_model,
        }
        return by_provider.get(self.llm_provider, "mock")

    @property
    def repos_dir(self) -> Path:
        return self.workdir / "repos"

    @property
    def runs_dir(self) -> Path:
        return self.workdir / "runs"
