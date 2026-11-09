"""Secret detection and redaction shared by logs, events, health and diff checks."""

from __future__ import annotations

import base64
import re
from collections.abc import Iterable

TOKEN_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("github-token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b")),
    ("github-pat", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b")),
    ("anthropic-key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b")),
    ("openai-key", re.compile(r"\bsk-[A-Za-z0-9_-]{24,}\b")),
    ("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("slack-token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b")),
    ("private-key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
]

_ASSIGN = re.compile(
    r"""(?ix)\b(\w*(?:secret|passw(?:or)?d|api[_-]?key|token|private[_-]?key)\w*)
        \s*[:=]\s*["']([^"'\s]{8,})["']"""
)
_PLACEHOLDERS = (
    "example", "placeholder", "changeme", "your", "xxx", "<", ">", "${", "dummy",
    "sample", "fake", "test", "process.env", "os.environ", "getenv", "secret-key-here",
)  # fmt: skip

_REDACT_PATTERNS = [p for _, p in TOKEN_PATTERNS] + [
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"(?i)\bBasic\s+[A-Za-z0-9+/=]{12,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)"),
]
_ASSIGN_REDACT = re.compile(
    r"""(?ix)((?:secret|passw(?:or)?d|api[_-]?key|token|authorization)["']?\s*[:=]\s*["']?)
        ([^\s"',;]{6,})"""
)


def scan_line(line: str) -> str | None:
    """Return the rule name if the line looks like it contains a credential."""
    for rule, pat in TOKEN_PATTERNS:
        if pat.search(line):
            return rule
    m = _ASSIGN.search(line)
    if m:
        value = m.group(2).lower()
        if not any(p in value for p in _PLACEHOLDERS) and len(set(value)) > 3:
            return "hardcoded-secret"
    return None


def redact(text: str, extra: Iterable[str] = ()) -> str:
    """Mask known secrets (and anything credential-shaped) in free text."""
    for secret in extra:
        if secret and len(secret) >= 4:
            text = text.replace(secret, "[REDACTED]")
    for pat in _REDACT_PATTERNS:
        text = pat.sub("[REDACTED]", text)
    return _ASSIGN_REDACT.sub(lambda m: m.group(1) + "[REDACTED]", text)


def truncate(value: str, limit: int = 500) -> str:
    return value if len(value) <= limit else value[:limit] + f"...[{len(value) - limit} more]"


def safe_args(args: dict[str, object], limit: int = 500) -> dict[str, object]:
    """Redact + truncate tool arguments for event/log output."""
    out: dict[str, object] = {}
    for k, v in args.items():
        out[k] = truncate(redact(v), limit) if isinstance(v, str) else v
    return out


def basic_auth_secrets(token: str) -> list[str]:
    """Strings derived from a token that must also be redacted (the base64 header value)."""
    return [token, base64.b64encode(f"x-access-token:{token}".encode()).decode()]
