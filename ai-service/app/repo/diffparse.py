"""Unified-diff parser that knows which RIGHT-side lines a review comment may legally target.

GitHub rejects review comments on lines that are not part of the diff, so every comment line is
validated (or relocated) against the parsed hunks.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$")
_GIT_HEADER = re.compile(r'^diff --git (?:"?a/(.+?)"?) (?:"?b/(.+?)"?)$')


@dataclass(slots=True)
class DiffLine:
    kind: str  # "+" added, "-" removed, " " context
    text: str
    old_no: int | None
    new_no: int | None


@dataclass(slots=True)
class Hunk:
    old_start: int
    old_count: int
    new_start: int
    new_count: int
    header: str
    lines: list[DiffLine] = field(default_factory=list)

    @property
    def added(self) -> list[int]:
        return [ln.new_no for ln in self.lines if ln.kind == "+" and ln.new_no is not None]

    @property
    def new_end(self) -> int:
        return self.new_start + max(self.new_count, 1) - 1


@dataclass(slots=True)
class FileDiff:
    old_path: str | None
    new_path: str | None
    status: str = "modified"  # added | modified | deleted | renamed
    binary: bool = False
    hunks: list[Hunk] = field(default_factory=list)

    @property
    def path(self) -> str:
        """The path on the RIGHT side (or the old path for a deleted file)."""
        return self.new_path or self.old_path or ""

    @property
    def additions(self) -> int:
        return sum(len(h.added) for h in self.hunks)

    @property
    def deletions(self) -> int:
        return sum(1 for h in self.hunks for ln in h.lines if ln.kind == "-")

    def added_lines(self) -> dict[int, str]:
        return {ln.new_no: ln.text for h in self.hunks for ln in h.lines if ln.kind == "+" and ln.new_no}

    def right_lines(self) -> set[int]:
        """Lines on the RIGHT side that can carry a comment: every added line."""
        return {n for h in self.hunks for n in h.added}


def _clean_path(raw: str) -> str | None:
    raw = raw.strip().split("\t", 1)[0]
    if raw.startswith('"') and raw.endswith('"') and len(raw) >= 2:
        raw = raw[1:-1]
    if raw == "/dev/null":
        return None
    return raw[2:] if raw[:2] in ("a/", "b/") else raw


def normalize_path(path: str) -> str:
    p = path.replace("\\", "/").strip()
    while p.startswith("./"):
        p = p[2:]
    if p[:2] in ("a/", "b/") and len(p) > 2:
        p = p[2:]
    return p.lstrip("/")


def parse_unified_diff(diff: str) -> list[FileDiff]:
    """Parse `git diff` / `diff -u` output. Tolerant of renames, binary files, deletions, CRLF and
    the "\\ No newline at end of file" marker."""
    files: list[FileDiff] = []
    cur: FileDiff | None = None
    hunk: Hunk | None = None
    old_no = new_no = 0
    old_left = new_left = 0
    for raw in diff.split("\n"):
        line = raw[:-1] if raw.endswith("\r") else raw
        if hunk is not None and (old_left > 0 or new_left > 0):
            c = line[:1]
            if c == "\\":
                continue  # "\ No newline at end of file"
            if c == "+":
                hunk.lines.append(DiffLine("+", line[1:], None, new_no))
                new_no += 1
                new_left -= 1
                continue
            if c == "-":
                hunk.lines.append(DiffLine("-", line[1:], old_no, None))
                old_no += 1
                old_left -= 1
                continue
            if c == " " or line == "":
                hunk.lines.append(DiffLine(" ", line[1:], old_no, new_no))
                old_no += 1
                new_no += 1
                old_left -= 1
                new_left -= 1
                continue
            old_left = new_left = 0  # malformed hunk: fall through and treat as a header line
        if line.startswith("\\"):
            continue
        m = _GIT_HEADER.match(line)
        if m:
            cur = FileDiff(m.group(1), m.group(2))
            files.append(cur)
            hunk = None
            continue
        h = _HUNK.match(line)
        if h:
            if cur is None:  # bare hunk without file headers
                cur = FileDiff(None, None)
                files.append(cur)
            old_start, old_count = int(h.group(1)), int(h.group(2) or 1)
            new_start, new_count = int(h.group(3)), int(h.group(4) or 1)
            hunk = Hunk(old_start, old_count, new_start, new_count, h.group(5).strip())
            cur.hunks.append(hunk)
            old_no, new_no, old_left, new_left = old_start, new_start, old_count, new_count
            continue
        if line.startswith("--- ") and (cur is None or cur.hunks):
            # plain `diff -u` (no `diff --git` line): a new file section starts here
            cur = FileDiff(_clean_path(line[4:]), None)
            if cur.old_path is None:
                cur.status = "added"
            files.append(cur)
            hunk = None
            continue
        if cur is None:
            continue
        if line.startswith("--- "):
            cur.old_path = _clean_path(line[4:])
            if cur.old_path is None:
                cur.status = "added"
        elif line.startswith("+++ "):
            cur.new_path = _clean_path(line[4:])
            if cur.new_path is None:
                cur.status = "deleted"
        elif line.startswith("new file mode"):
            cur.status = "added"
        elif line.startswith("deleted file mode"):
            cur.status = "deleted"
        elif line.startswith("rename from "):
            cur.old_path = _clean_path(line[12:])
            cur.status = "renamed"
        elif line.startswith("rename to "):
            cur.new_path = _clean_path(line[10:])
            cur.status = "renamed"
        elif line.startswith("Binary files") or line.startswith("GIT binary patch"):
            cur.binary = True
    for f in files:
        if f.status == "deleted":
            f.new_path = None if f.new_path in (None, f.old_path) else f.new_path
    return files


def diff_stats(files: list[FileDiff]) -> dict[str, int]:
    return {
        "files": len(files), "additions": sum(f.additions for f in files),
        "deletions": sum(f.deletions for f in files),
    }  # fmt: skip


def resolve_file(files: list[FileDiff], path: str) -> FileDiff | None:
    """Find the diff file a comment path refers to (exact, then unique path-suffix match)."""
    want = normalize_path(path)
    live = [f for f in files if f.new_path and f.status != "deleted"]
    for f in live:
        if normalize_path(f.path) == want:
            return f
    cands = [f for f in live if want and (normalize_path(f.path).endswith("/" + want) or want.endswith("/" + normalize_path(f.path)))]
    return cands[0] if len(cands) == 1 else None


def map_comment_line(f: FileDiff, line: int, max_distance: int = 3) -> int | None:
    """A valid RIGHT-side line for a comment aimed at `line`, or None if it cannot be placed.

    Added lines are used as-is. A line inside a hunk (context) moves to the nearest added line of that
    hunk within `max_distance`; anything outside every hunk is dropped.
    """
    added = f.right_lines()
    if line in added:
        return line
    for h in f.hunks:
        if h.new_start <= line <= h.new_end:
            near = [n for n in h.added if abs(n - line) <= max_distance]
            if near:
                return min(near, key=lambda n: (abs(n - line), n))
    return None


# ---- truncation -------------------------------------------------------------------------------------


def truncate_diff(diff: str, per_file: int = 16_000, total: int = 80_000) -> tuple[str, list[str]]:
    """Shrink a huge diff for the model: each file gets a character budget (cut at hunk boundaries) and
    the whole text is bounded. Returns (text, paths that were cut or omitted)."""
    parts = re.split(r"(?m)^(?=diff --git )", diff)
    out: list[str] = []
    cut: list[str] = []
    used = 0
    for part in parts:
        if not part.strip():
            continue
        m = _GIT_HEADER.match(part.split("\n", 1)[0])
        name = m.group(2) if m else "(file)"
        if used >= total:
            cut.append(name)
            continue
        budget = min(per_file, total - used)
        if len(part) > budget:
            chunks = re.split(r"(?m)^(?=@@ )", part)
            kept, size = [chunks[0]], len(chunks[0])
            for ch in chunks[1:]:
                if size + len(ch) > budget:
                    break
                kept.append(ch)
                size += len(ch)
            part = "".join(kept)
            if len(kept) == 1 and len(chunks) > 1:  # even the first hunk is too big: hard cut
                part += chunks[1][: max(budget - size, 0)]
            part = part.rstrip("\n") + "\n\\ [DevForge: diff truncated for review]\n"
            cut.append(name)
        out.append(part)
        used += len(part)
    return "".join(out) if out else diff[:total], cut
