
"""Structured outputs: ask the model for JSON that matches a Pydantic schema, and always validate it.

Order of attempts: provider-native JSON schema -> native JSON mode -> plain prompt. A mode the provider rejects
(HTTP 400) is remembered for the process so later calls skip it. Anthropic has no response_format, so it goes
straight to the prompt route. Every result is validated by Pydantic; invalid output returns None, never garbage.
"""

from __future__ import annotations

import json
from typing import TypeVar

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage, HumanMessage
from pydantic import BaseModel, Field, ValidationError

from app.errors import ApiError
from app.llm.loop import ainvoke, extract_json
from app.llm.usage import UsageMeter

T = TypeVar("T", bound=BaseModel)

# Gemini Interactions API uses prompt-based structured output here.
# Other providers retain their native JSON response-format support.
NATIVE = frozenset({
    "openai",
    "groq",
    "openrouter",
    "ollama",
    "openai_compatible",
})

_rejected: set[tuple[str, str]] = set()


# ---- schemas used across the app ---------------------------------------------------------


class PlanStepOut(BaseModel):
    title: str
    detail: str = ""
    files: list[str] = Field(default_factory=list)


class PlanOut(BaseModel):
    summary: str = ""
    requirements: list[str] = Field(default_factory=list)
    design: str = ""
    steps: list[PlanStepOut] = Field(default_factory=list)


class ReviewCommentOut(BaseModel):
    path: str = ""
    line: int = 1
    severity: str = "info"
    body: str = ""


class ReviewOut(BaseModel):
    summary: str = ""
    comments: list[ReviewCommentOut] = Field(default_factory=list)


class FindingOut(BaseModel):
    path: str
    line: int = 1
    severity: str = "low"
    title: str
    detail: str = ""
    suggestion: str = ""


class FindingsOut(BaseModel):
    findings: list[FindingOut] = Field(default_factory=list)


class RankOut(BaseModel):
    ranking: list[int] = Field(
        default_factory=list,
        description="candidate ids, most relevant first",
    )


# ---- machinery -------------------------------------------------------------------------------


def parse[T: BaseModel](text: str, schema: type[T]) -> T | None:
    """Validate model text against schema; tolerant of fences and surrounding prose."""
    data = extract_json(text)

    if data is None:
        return None

    try:
        return schema.model_validate(data)
    except ValidationError:
        return None


def _response_format(mode: str, schema: type[BaseModel]) -> dict[str, object]:
    if mode == "json_schema":
        return {
            "type": "json_schema",
            "json_schema": {
                "name": schema.__name__,
                "schema": schema.model_json_schema(),
                "strict": False,
            },
        }

    return {"type": "json_object"}


async def structured[T: BaseModel](
    model: BaseChatModel,
    messages: list[BaseMessage],
    schema: type[T],
    meter: UsageMeter,
    *,
    provider: str,
    model_name: str | None = None,
    operation: str = "structured",
) -> tuple[T | None, str]:
    """Returns (validated object or None, mode used: json_schema | json_object | prompt)."""

    hint = HumanMessage(
        "Reply with ONLY one valid JSON object matching this JSON schema. "
        "Do not include prose or markdown fences:\n"
        + json.dumps(schema.model_json_schema())
    )

    if provider in NATIVE:
        for mode in ("json_schema", "json_object"):
            if (provider, mode) in _rejected:
                continue

            msgs = messages if mode == "json_schema" else [*messages, hint]

            try:
                text = await ainvoke(
                    model.bind(response_format=_response_format(mode, schema)),
                    list(msgs),
                    meter,
                    model_name=model_name,
                    provider=provider,
                    operation=operation,
                )
            except ApiError as e:
                if e.code == "provider_error":
                    _rejected.add((provider, mode))
                    continue
                raise

            parsed = parse(text, schema)

            if parsed is not None:
                return parsed, mode

    text = await ainvoke(
        model,
        [*messages, hint],
        meter,
        model_name=model_name,
        provider=provider,
        operation=operation,
    )

    return parse(text, schema), "prompt"