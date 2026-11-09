"""Small shared types."""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable

from app.errors import bad_request

JsonDict = dict[str, object]
Emit = Callable[[str, JsonDict], Awaitable[None]]

_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")


def valid_id(value: str, what: str = "id") -> str:
    """IDs become directory names: reject anything that could traverse."""
    if not _ID.match(value) or ".." in value:
        raise bad_request("invalid_id", f"invalid {what}")
    return value
