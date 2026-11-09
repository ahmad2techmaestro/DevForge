"""File walking, language detection and workspace-confined path resolution."""

from __future__ import annotations

import os
import re
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

MAX_FILE_BYTES = 1_000_000
MAX_TOTAL_BYTES = 150_000_000
MAX_FILES = 20_000

IGNORED_DIRS = frozenset(
    {
        ".git", "node_modules", ".venv", "venv", "env", "__pycache__", ".tox", ".mypy_cache",
        ".pytest_cache", ".ruff_cache", "dist", "build", ".next", ".nuxt", ".cache", "coverage",
        ".idea", ".vscode", ".gradle", ".terraform", "site-packages", ".devforge_deps",
    }
)  # fmt: skip

LANGUAGES: dict[str, str] = {
    ".py": "Python", ".pyi": "Python", ".js": "JavaScript", ".jsx": "JavaScript",
    ".mjs": "JavaScript", ".cjs": "JavaScript", ".ts": "TypeScript", ".tsx": "TypeScript",
    ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".rb": "Ruby", ".php": "PHP",
    ".c": "C", ".h": "C", ".cc": "C++", ".cpp": "C++", ".hpp": "C++", ".cs": "C#",
    ".swift": "Swift", ".sh": "Shell", ".bash": "Shell", ".sql": "SQL", ".html": "HTML",
    ".css": "CSS", ".scss": "CSS", ".json": "JSON", ".yml": "YAML", ".yaml": "YAML",
    ".toml": "TOML", ".md": "Markdown", ".mdx": "Markdown", ".txt": "Text", ".xml": "XML",
    ".vue": "Vue", ".svelte": "Svelte", ".dockerfile": "Dockerfile",
}  # fmt: skip

BINARY_EXTS = frozenset(
    {
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".pdf", ".zip", ".gz", ".tar",
        ".tgz", ".7z", ".rar", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".mov",
        ".avi", ".wav", ".so", ".dll", ".dylib", ".exe", ".bin", ".class", ".jar", ".pyc", ".o",
        ".a", ".wasm", ".sqlite", ".db", ".lock-bin",
    }
)  # fmt: skip

CODE_LANGUAGES = frozenset({"Python", "JavaScript", "TypeScript"})
_TEST_RE = re.compile(
    r"(^|/)(tests?|__tests__|spec)/|(^|/)test_[^/]*\.py$|_test\.(py|go)$|\.(test|spec)\.[cm]?[jt]sx?$"
)


class PathEscapeError(ValueError):
    """A path tried to leave its root (absolute, `..`, or symlink escape)."""


@dataclass(frozen=True, slots=True)
class FileInfo:
    path: str
    size: int
    language: str
    lines: int


def detect_language(path: str) -> str:
    name = os.path.basename(path)
    if name == "Dockerfile" or name.startswith("Dockerfile."):
        return "Dockerfile"
    if name == "Makefile":
        return "Makefile"
    return LANGUAGES.get(os.path.splitext(name)[1].lower(), "Other")


def is_test_path(path: str) -> bool:
    return bool(_TEST_RE.search(path))


def count_lines(text: str) -> int:
    return text.count("\n") + (0 if not text or text.endswith("\n") else 1)


def safe_join(root: Path, rel: str) -> Path:
    """Resolve `rel` under `root`, rejecting absolute paths, `..` and symlink escapes."""
    if not rel or "\x00" in rel:
        raise PathEscapeError("empty or invalid path")
    if rel.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", rel):
        raise PathEscapeError("absolute paths are not allowed")
    if ".." in rel.replace("\\", "/").split("/"):
        raise PathEscapeError("'..' is not allowed in paths")
    base = os.path.realpath(root)
    target = os.path.realpath(os.path.join(base, rel))
    if target != base and not target.startswith(base + os.sep):
        raise PathEscapeError("path escapes the workspace")
    return Path(target)


def iter_repo(root: Path) -> Iterator[tuple[FileInfo, str]]:
    """Yield (info, text) for every indexable text file, in sorted order."""
    total = 0
    count = 0
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(
            d for d in dirnames if d not in IGNORED_DIRS and not os.path.islink(os.path.join(dirpath, d))
        )
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            if os.path.islink(full) or os.path.splitext(name)[1].lower() in BINARY_EXTS:
                continue
            try:
                size = os.path.getsize(full)
                if size > MAX_FILE_BYTES:
                    continue
                with open(full, "rb") as fh:
                    data = fh.read()
            except OSError:
                continue
            if b"\x00" in data[:8192]:
                continue
            total += size
            count += 1
            if count > MAX_FILES or total > MAX_TOTAL_BYTES:
                return
            text = data.decode("utf-8", errors="replace")
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            yield FileInfo(rel, size, detect_language(rel), count_lines(text)), text
