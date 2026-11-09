"""Tool-calling loop over a LangChain chat model."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from email.utils import parsedate_to_datetime

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage

from app.config import cost_usd
from app.errors import ApiError
from app.llm import observability
from app.llm.tools import WorkspaceTools
from app.llm.usage import UsageMeter
from app.types import Emit

log = logging.getLogger("devforge.llm")

# Retry policy for transient provider failures (module-level so tests/ops can tune it).
MAX_RETRIES = 4
RETRY_BASE_DELAY = 1.0
RETRY_MAX_DELAY = 30.0
KEY_ENV = {
    "anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY", "gemini": "GEMINI_API_KEY",
    "groq": "GROQ_API_KEY", "openrouter": "OPENROUTER_API_KEY", "ollama": "OPENAI_API_KEY",
    "openai_compatible": "OPENAI_API_KEY",
}
_SECRET = re.compile(
    r"(Bearer\s+[A-Za-z0-9._\-]{6,}|sk-[A-Za-z0-9_\-]{6,}|gsk_[A-Za-z0-9]{6,}|AIza[A-Za-z0-9_\-]{10,}"
    r"|(?:api[_-]?key|authorization)[\"']?\s*[:=]\s*[\"']?[A-Za-z0-9._\-]{6,})", re.I,
)


def scrub(text: str, limit: int = 300) -> str:
    """Strip anything key-shaped from provider error text before it is shown or logged."""
    return _SECRET.sub("[redacted]", text)[:limit]


async def _sleep(seconds: float) -> None:
    await asyncio.sleep(seconds)


def _status_of(exc: BaseException) -> int | None:
    status = getattr(exc, "status_code", None)
    if status is None:
        status = getattr(getattr(exc, "response", None), "status_code", None)
    return status if isinstance(status, int) else None


def _retry_after(exc: BaseException) -> float | None:
    headers = getattr(getattr(exc, "response", None), "headers", None)
    if not headers:
        return None
    try:
        ms = headers.get("retry-after-ms")
        if ms:
            return max(0.0, float(ms) / 1000)
        raw = headers.get("retry-after")
        if not raw:
            return None
        try:
            return max(0.0, float(raw))
        except ValueError:
            return max(0.0, parsedate_to_datetime(raw).timestamp() - time.time())
    except Exception:
        return None


def _is_transient(exc: BaseException) -> bool:
    status = _status_of(exc)
    if status is not None:
        return status in (408, 409, 429) or status >= 500
    names = {c.__name__ for c in type(exc).__mro__}
    return bool(names & {"TimeoutException", "APITimeoutError", "APIConnectionError", "ConnectError",
                         "ReadError", "RemoteProtocolError", "TimeoutError", "ConnectTimeout"})


def map_provider_error(exc: BaseException, provider: str, final: bool = True) -> ApiError | None:
    """Translate an SDK exception into an ApiError (never includes keys). None = not a provider error."""
    status = _status_of(exc)
    label = provider or "LLM provider"
    env = KEY_ENV.get(provider, "the provider API key")
    if status in (401, 403):
        return ApiError(502, "provider_auth_failed",
                        f"{label} rejected the credentials (HTTP {status}); check {env}")
    if status == 429:
        return ApiError(503, "provider_rate_limited", f"{label} rate limit exceeded (HTTP 429); retry later")
    if status is not None and status >= 500:
        return ApiError(503, "provider_unavailable", f"{label} is unavailable (HTTP {status})")
    if status is not None:
        hint = "; check the model name" if status == 404 else ""
        return ApiError(502, "provider_error", f"{label} returned HTTP {status}{hint}: {scrub(str(exc))}")
    if _is_transient(exc):
        return ApiError(503, "provider_unavailable", f"{label} timed out or is unreachable ({type(exc).__name__})")
    return None


def model_label(model: object, fallback: str | None = None) -> str | None:
    """Best-effort model name from a LangChain chat model."""
    for attr in ("model_name", "model"):
        val = getattr(model, attr, None)
        if isinstance(val, str) and val:
            return val
    return fallback


async def call_model(
    runnable: object, messages: list[BaseMessage], meter: UsageMeter, *,
    model_name: str | None = None, provider: str = "", operation: str = "chat",
) -> BaseMessage:
    """ainvoke with retry/backoff (429/5xx/timeouts, honouring Retry-After), usage + tracing."""
    name = model_name or meter.model
    attempt = 0
    while True:
        started = time.perf_counter()
        try:
            resp = await runnable.ainvoke(messages)  # type: ignore[attr-defined]
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            mapped = map_provider_error(exc, provider)
            if mapped is None:
                raise
            observability.record_llm_call(
                provider=provider, model=name, input_tokens=0, output_tokens=0,
                latency_s=time.perf_counter() - started, cost_usd=0.0, operation=operation,
                error=mapped.code,
            )
            if mapped.code in ("provider_auth_failed", "provider_error") or attempt >= MAX_RETRIES:
                raise mapped from None
            delay = _retry_after(exc)
            if delay is None:
                delay = min(RETRY_MAX_DELAY, RETRY_BASE_DELAY * (2**attempt))
            delay = min(delay, 60.0)
            attempt += 1
            log.warning("%s call failed (%s); retry %d/%d in %.1fs", provider, mapped.code, attempt,
                        MAX_RETRIES, delay)
            await _sleep(delay)
            continue
        i = o = 0
        if isinstance(resp, AIMessage) and resp.usage_metadata:
            i = int(resp.usage_metadata.get("input_tokens", 0))
            o = int(resp.usage_metadata.get("output_tokens", 0))
            meter.add(i, o, name)
        observability.record_llm_call(
            provider=provider, model=name, input_tokens=i, output_tokens=o,
            latency_s=time.perf_counter() - started, cost_usd=cost_usd(name, i, o), operation=operation,
        )
        return resp


def text_of(msg: BaseMessage) -> str:
    content = msg.content
    if isinstance(content, str):
        return content
    parts: list[str] = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict) and block.get("type") == "text":
            parts.append(str(block.get("text", "")))
    return "".join(parts)


def extract_json(text: str) -> dict[str, object] | None:
    """Pull the first JSON object out of model text (handles ```json fences and prose around it)."""
    candidates = [m.group(1) for m in re.finditer(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", text)]
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        candidates.append(text[start : end + 1])
    for c in candidates:
        try:
            val = json.loads(c)
        except ValueError:
            continue
        if isinstance(val, dict):
            return val
    # Fallback: first balanced object that parses, even with trailing chatter or a second object.
    decoder = json.JSONDecoder()
    pos = text.find("{")
    while pos != -1:
        try:
            val, _ = decoder.raw_decode(text, pos)
            if isinstance(val, dict):
                return val
        except ValueError:
            pass
        pos = text.find("{", pos + 1)
    return None


async def ainvoke(
    model: BaseChatModel, messages: list[BaseMessage], meter: UsageMeter, *,
    model_name: str | None = None, provider: str = "", operation: str = "chat",
) -> str:
    resp = await call_model(model, messages, meter, model_name=model_name, provider=provider,
                            operation=operation)
    return text_of(resp)


async def run_tool_loop(
    model: BaseChatModel,
    system: str,
    user: str,
    tools: WorkspaceTools,
    meter: UsageMeter,
    emit: Emit,
    *,
    max_iterations: int,
    token_budget: int,
    model_name: str | None = None,
    provider: str = "",
    operation: str = "agent",
) -> str:
    """Run until the model stops calling tools, or the iteration/token budget is hit."""
    bound = model.bind_tools(tools.schemas())
    messages: list[BaseMessage] = [SystemMessage(system), HumanMessage(user)]
    last_text = ""
    for i in range(max_iterations):
        if meter.total_tokens >= token_budget:
            await emit("log", {"level": "warn", "message": "token budget exhausted; stopping tool loop"})
            return last_text or "Stopped: token budget exhausted."
        resp = await call_model(bound, messages, meter, model_name=model_name, provider=provider,
                                operation=operation)
        if not isinstance(resp, AIMessage):
            return text_of(resp)
        messages.append(resp)
        last_text = text_of(resp) or last_text
        if not resp.tool_calls:
            return last_text
        for call in resp.tool_calls:
            args = {str(k): v for k, v in dict(call["args"]).items()}
            ok, result = await tools.execute(call["name"], args)
            messages.append(ToolMessage(content=result, tool_call_id=call["id"] or f"call-{i}", status="success" if ok else "error"))
    await emit("log", {"level": "warn", "message": f"stopped after {max_iterations} iterations"})
    return last_text or f"Stopped after {max_iterations} iterations."
