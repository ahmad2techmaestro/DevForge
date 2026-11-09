"""Diff risk scoring and unified-diff parsing."""

from __future__ import annotations

import re

from app.repo.files import is_test_path
from app.schemas import DiffFile, Risk

_SENSITIVE: list[tuple[re.Pattern[str], str, int]] = [
    (re.compile(r"(?i)(^|/)(auth|security|crypto|permissions?|session|login|passw)"), "auth/security code", 20),
    (re.compile(r"(?i)(^|/)(migrations?|alembic)/|\.sql$"), "database migrations/SQL", 20),
    (re.compile(r"(?i)^\.github/|(^|/)(Jenkinsfile|\.gitlab-ci\.yml)$"), "CI configuration", 15),
    (re.compile(r"(?i)(^|/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml)$"), "Dockerfile / compose", 15),
    (re.compile(r"(?i)(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|uv\.lock|Pipfile\.lock)$"),
     "lockfile", 10),
    (re.compile(r"(?i)(^|/)\.env"), "environment file", 20),
]  # fmt: skip
_DIFF_FILE = re.compile(r"^diff --git a/(.*?) b/(.*)$", re.M)


def changed_paths(diff: str) -> list[str]:
    return [m.group(2) for m in _DIFF_FILE.finditer(diff)]


def parse_diff(diff: str) -> list[DiffFile]:
    files: list[DiffFile] = []
    chunks = re.split(r"(?m)^(?=diff --git )", diff)
    for chunk in chunks:
        m = _DIFF_FILE.match(chunk)
        if not m:
            continue
        add = sum(1 for ln in chunk.splitlines() if ln.startswith("+") and not ln.startswith("+++"))
        dele = sum(1 for ln in chunk.splitlines() if ln.startswith("-") and not ln.startswith("---"))
        status = "added" if "\nnew file mode" in chunk else "deleted" if "\ndeleted file mode" in chunk else "modified"
        files.append(DiffFile(path=m.group(2), status=status, additions=add, deletions=dele))  # type: ignore[arg-type]
    return files


def score_diff(files: list[DiffFile]) -> Risk:
    if not files:
        return Risk(score=0, level="low", reasons=["No changes."])
    reasons: list[str] = []
    score = 0
    adds = sum(f.additions for f in files)
    dels = sum(f.deletions for f in files)
    size = adds + dels
    size_pts = min(size // 20, 25)
    if size_pts:
        score += size_pts
        reasons.append(f"Large change: +{adds}/-{dels} lines across {len(files)} files.")
    if len(files) > 10:
        score += 10
        reasons.append(f"Touches {len(files)} files.")
    seen: set[str] = set()
    for f in files:
        for pat, label, pts in _SENSITIVE:
            if pat.search(f.path) and label not in seen:
                seen.add(label)
                score += pts
                reasons.append(f"Touches {label}: {f.path}")
    deleted = [f for f in files if f.status == "deleted"]
    if deleted or dels > 2 * max(adds, 1) and dels > 30:
        score += 10 + min(len(deleted) * 3, 10)
        reasons.append(f"Deletes code ({len(deleted)} files removed, {dels} lines deleted).")
    src = [f for f in files if not is_test_path(f.path) and re.search(r"\.(py|[cm]?[jt]sx?|go|rs|java)$", f.path)]
    has_tests = any(is_test_path(f.path) for f in files)
    if src and not has_tests:
        score += 15
        reasons.append("Source files changed without any test changes.")
    score = min(score, 100)
    level = "high" if score >= 60 else "medium" if score >= 30 else "low"
    if not reasons:
        reasons.append("Small, low-sensitivity change.")
    return Risk(score=score, level=level, reasons=reasons)  # type: ignore[arg-type]


_HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")


def added_lines(diff: str) -> dict[str, dict[int, str]]:
    """Map path -> {new line number: text} for every added line in a unified diff."""
    out: dict[str, dict[int, str]] = {}
    path: str | None = None
    new_no = 0
    for ln in diff.splitlines():
        if ln.startswith("diff --git "):
            m = _DIFF_FILE.match(ln)
            path = m.group(2) if m else None
            if path:
                out.setdefault(path, {})
        elif (h := _HUNK.match(ln)) and path:
            new_no = int(h.group(1))
        elif path and ln.startswith("+") and not ln.startswith("+++"):
            out[path][new_no] = ln[1:]
            new_no += 1
        elif path and ln.startswith(" "):
            new_no += 1
    return out
