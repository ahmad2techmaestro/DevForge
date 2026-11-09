"""Static-rule review comments restricted to the lines a diff adds."""

from __future__ import annotations

from app.repo.files import detect_language, is_test_path
from app.repo.index import RepoIndex
from app.repo.risk import added_lines
from app.repo.rules import analyze_file
from app.schemas import ReviewComment

NOTE_PATH = "docs/DEVFORGE_CHANGES.md"


def static_comments(diff: str, index: RepoIndex | None) -> list[ReviewComment]:
    comments: list[ReviewComment] = []
    for path, new_lines in added_lines(diff).items():
        info = index.by_path(path) if index else None
        lang = info.language if info else detect_language(path)
        if index and path in index.texts:
            text = index.texts[path]
        else:  # brand-new file not in the index: rebuild it from the added lines
            top = max(new_lines, default=0)
            text = "\n".join(new_lines.get(i, "") for i in range(1, top + 1))
        for f in analyze_file(path, lang, text):
            if f.line in new_lines:
                sev = "high" if f.severity == "critical" else f.severity
                comments.append(
                    ReviewComment(path=path, line=f.line, severity=sev, body=f"{f.title}. {f.detail}")  # type: ignore[arg-type]
                )
        if is_test_path(path) and "devforge" in path.lower():
            comments.append(ReviewComment(path=path, line=1, severity="info",
                                          body="Auto-generated smoke test: confirm it asserts meaningful behaviour."))  # fmt: skip
        if path == NOTE_PATH:
            comments.append(ReviewComment(path=path, line=1, severity="info",
                                          body="Demo note written by the mock provider; no source files were changed."))  # fmt: skip
    return comments
