"""X-Internal-Key authentication dependency."""

from __future__ import annotations

import hmac

from fastapi import Header, Request

from app.errors import ApiError


async def require_key(request: Request, x_internal_key: str | None = Header(default=None)) -> None:
    expected: str = request.app.state.settings.internal_key
    if not x_internal_key or not hmac.compare_digest(x_internal_key, expected):
        raise ApiError(401, "unauthorized", "missing or invalid X-Internal-Key")
