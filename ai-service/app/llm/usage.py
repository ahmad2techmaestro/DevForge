"""Token + cost accounting, attributed per model (routing may use two models in one run)."""

from __future__ import annotations

from app.config import cost_usd
from app.schemas import Usage


class UsageMeter:
    def __init__(self, model: str) -> None:
        self.model = model  # default model, used when add() is called without one
        self.input_tokens = 0
        self.output_tokens = 0
        self.by_model: dict[str, tuple[int, int]] = {}

    def add(self, input_tokens: int, output_tokens: int, model: str | None = None) -> None:
        self.input_tokens += input_tokens
        self.output_tokens += output_tokens
        name = model or self.model
        prev_in, prev_out = self.by_model.get(name, (0, 0))
        self.by_model[name] = (prev_in + input_tokens, prev_out + output_tokens)

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    @property
    def cost(self) -> float:
        """Sum of per-model costs; unknown models cost 0."""
        return sum(cost_usd(m, i, o) for m, (i, o) in self.by_model.items())

    def snapshot(self) -> Usage:
        return Usage(
            inputTokens=self.input_tokens,
            outputTokens=self.output_tokens,
            costUsd=round(self.cost, 6),
        )
