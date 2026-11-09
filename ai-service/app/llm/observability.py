"""Optional OpenTelemetry tracing of LLM calls (Langfuse/OTLP compatible).

Enabled only when `settings.otlp_endpoint` is set AND `opentelemetry-sdk` plus the OTLP HTTP
exporter are installed (`pip install .[trace]`). Everything here is best-effort and never raises.
"""

from __future__ import annotations

import logging
import threading

from app.config import Settings

log = logging.getLogger("devforge.trace")

_lock = threading.Lock()
_tracer: object | None = None
_configured_for: str | None = None


def configure(settings: Settings) -> bool:
    """Idempotently set up the tracer. Returns True when tracing is active."""
    global _tracer, _configured_for
    endpoint = settings.otlp_endpoint
    if not endpoint:
        return False
    with _lock:
        if _configured_for == endpoint:
            return _tracer is not None
        _configured_for = endpoint
        try:
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
            from opentelemetry.sdk.resources import Resource
            from opentelemetry.sdk.trace import TracerProvider
            from opentelemetry.sdk.trace.export import BatchSpanProcessor

            url = endpoint.rstrip("/")
            if not url.endswith("/v1/traces"):
                url += "/v1/traces"
            provider = TracerProvider(resource=Resource.create({"service.name": "devforge-ai-service"}))
            provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=url)))
            _tracer = provider.get_tracer("devforge.llm")
        except Exception as e:  # missing optional deps or bad config: tracing stays off
            _tracer = None
            log.warning("tracing disabled: %s", type(e).__name__)
        return _tracer is not None


def record_llm_call(
    *, provider: str, model: str, input_tokens: int, output_tokens: int, latency_s: float,
    cost_usd: float, operation: str = "chat", error: str | None = None,
) -> None:
    """Emit one span per LLM call. No-op when tracing is off; never raises."""
    tracer = _tracer
    if tracer is None:
        return
    try:
        import time

        end = time.time_ns()
        span = tracer.start_span(  # type: ignore[attr-defined]
            f"llm.{operation}", start_time=end - int(latency_s * 1e9),
            attributes={
                "llm.provider": provider, "llm.model": model, "gen_ai.system": provider,
                "gen_ai.request.model": model, "gen_ai.usage.input_tokens": input_tokens,
                "gen_ai.usage.output_tokens": output_tokens, "llm.latency_ms": round(latency_s * 1000, 1),
                "llm.cost_usd": cost_usd,
            },
        )
        if error:
            span.set_attribute("error.type", error)
        span.end(end_time=end)
    except Exception:  # noqa: S110
        pass


def reset() -> None:
    """Test helper: drop the tracer."""
    global _tracer, _configured_for
    with _lock:
        _tracer, _configured_for = None, None
