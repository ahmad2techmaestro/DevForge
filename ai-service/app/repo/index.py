"""RepoIndex: in-memory view of one repository checkout, plus the on-disk repo service."""

from __future__ import annotations

import asyncio
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote, urlparse

from app.errors import ApiError, bad_request, not_found
from app.repo import gitops
from app.repo.files import FileInfo, PathEscapeError, iter_repo, safe_join
from app.repo.graph import build_graph
from app.repo.health import compute_health
from app.repo.search import BM25Index
from app.schemas import IndexRequest
from app.types import valid_id

MAX_READ_CHARS = 200_000


def resolve_local_path(raw: str | None) -> Path:
    """Turn what a person typed into an existing folder, or raise an error that says what to fix.

    Accepts a path pasted from Windows "Copy as path" (with quotes), a file:// URL, and `~`.
    """
    text = (raw or "").strip().strip("\"'").strip()
    if not text:
        raise bad_request("invalid_local_path", "Enter the full path of a folder on the machine that runs DevForge.")
    if re.match(r"^(https?://|git@|ssh://)", text, re.IGNORECASE) or re.match(r"^(www\.)?github\.com/", text, re.IGNORECASE):
        raise bad_request("invalid_local_path", "That is a web address, not a folder. Use the Clone URL tab for repository links.")
    if text.lower().startswith("file://"):
        path = unquote(urlparse(text).path)
        text = path[1:] if re.match(r"^/[A-Za-z]:", path) else path
    src = Path(text).expanduser()
    if not src.is_absolute():
        raise bad_request("invalid_local_path", f"'{text}' is a relative path. Use the full path, for example C:\\Users\\you\\project or /home/you/project.")
    if src.is_file():
        raise bad_request("invalid_local_path", f"{src} is a file. Choose the project folder that contains it.")
    if not src.is_dir():
        raise bad_request("invalid_local_path", f"Folder not found: {src}. It must exist on the machine that runs DevForge (not on a remote server or inside WSL/Docker).")
    return src


@dataclass
class RepoIndex:
    root: Path
    files: list[FileInfo]
    texts: dict[str, str]
    bm25: BM25Index
    _health: dict[str, object] | None = field(default=None, repr=False)
    _graph: dict[str, list[dict[str, object]]] | None = field(default=None, repr=False)
    _intel: object | None = field(default=None, repr=False)
    _semantic: object | None = field(default=None, repr=False)

    @classmethod
    def from_dir(cls, root: Path) -> RepoIndex:
        files: list[FileInfo] = []
        texts: dict[str, str] = {}
        for info, text in iter_repo(root):
            files.append(info)
            texts[info.path] = text
        return cls(root, files, texts, BM25Index(texts))

    def by_path(self, path: str) -> FileInfo | None:
        return next((f for f in self.files if f.path == path), None)

    def read(self, path: str) -> tuple[FileInfo, str, bool]:
        try:
            safe_join(self.root, path)
        except PathEscapeError as e:
            raise bad_request("invalid_path", str(e)) from None
        info = self.by_path(path)
        if info is None:
            raise not_found("file_not_found", f"file not found: {path}")
        text = self.texts[path]
        return info, text[:MAX_READ_CHARS], len(text) > MAX_READ_CHARS

    def languages(self) -> dict[str, dict[str, int]]:
        langs: dict[str, dict[str, int]] = {}
        for f in self.files:
            entry = langs.setdefault(f.language, {"files": 0, "lines": 0})
            entry["files"] += 1
            entry["lines"] += f.lines
        return dict(sorted(langs.items(), key=lambda kv: -kv[1]["lines"]))

    def intel(self):  # type: ignore[no-untyped-def]
        """Symbols, call graph and impact analysis (built once per index)."""
        from app.repo.intel import CodeIntel

        if self._intel is None:
            self._intel = CodeIntel.build(self)
        return self._intel

    def semantic(self, embedder=None, cache=None):  # type: ignore[no-untyped-def]
        from app.repo.embeddings import HashEmbedder
        from app.repo.semantic import SemanticIndex

        if self._semantic is None:
            self._semantic = SemanticIndex(self, embedder or HashEmbedder(), cache)
        return self._semantic

    async def hybrid_search(self, query: str, limit: int = 10, embedder=None, reranker=None):  # type: ignore[no-untyped-def]
        """BM25 + embeddings fused with RRF, optionally reranked. Same dict as GET semantic-search (+ `reranker`)."""
        from app.repo.rerank import apply_rerank

        if reranker is None:
            return await self.semantic(embedder).search(query, "hybrid", limit)
        res = await self.semantic(embedder).search(query, "hybrid", max(limit * 3, 20))
        res["results"], res["reranker"] = await apply_rerank(reranker, query, res["results"], limit)  # type: ignore[arg-type]
        return res

    def health(self) -> dict[str, object]:
        if self._health is None:
            self._health = compute_health(self.files, self.texts)
        return self._health

    def graph(self) -> dict[str, list[dict[str, object]]]:
        if self._graph is None:
            self._graph = build_graph(self.files, self.texts)
        return self._graph

    def summary(self) -> str:
        langs = [k for k in self.languages() if k not in ("Markdown", "JSON", "YAML", "Text", "Other")]
        total = sum(f.lines for f in self.files)
        top = sorted({f.path.split("/")[0] for f in self.files if "/" in f.path})[:8]
        readme = next((t for p, t in self.texts.items() if p.lower().startswith("readme")), "")
        intro = next((ln.strip("# ").strip() for ln in readme.splitlines() if ln.strip()), "")
        parts = [f"{len(self.files)} files, {total} lines."]
        if langs:
            parts.append(f"Main languages: {', '.join(langs[:3])}.")
        if top:
            parts.append(f"Top-level directories: {', '.join(top)}.")
        if intro:
            parts.append(f"README: {intro[:160]}")
        return " ".join(parts)


class RepoService:
    def __init__(self, repos_dir: Path, allow_local: bool = True) -> None:
        self.repos_dir = repos_dir
        self._cache: dict[str, RepoIndex] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def path(self, repo_id: str) -> Path:
        return self.repos_dir / valid_id(repo_id, "repoId")

    async def index(self, req: IndexRequest) -> dict[str, object]:
        dest = self.path(req.repoId)
        lock = self._locks.setdefault(req.repoId, asyncio.Lock())
        async with lock:
            self._cache.pop(req.repoId, None)
            if req.cloneUrl:
                parsed = urlparse(req.cloneUrl)
                if parsed.scheme not in ("http", "https", "git", "ssh", "file"):
                    raise bad_request("invalid_clone_url", "cloneUrl must be http(s), git or ssh")
                if parsed.username or parsed.password:
                    raise bad_request("invalid_clone_url", "cloneUrl must not embed credentials; use token")
                await gitops.clone(req.cloneUrl, dest, req.branch, req.token)
            else:
                src = resolve_local_path(req.localPath)
                await gitops.copy_local(src.resolve(), dest, req.branch)
            idx = await asyncio.to_thread(RepoIndex.from_dir, dest)
            self._cache[req.repoId] = idx
            commit = await gitops.head_commit(dest)
            branch = await gitops.current_branch(dest)
        return {
            "repoId": req.repoId, "commit": commit, "branch": branch,
            "fileCount": len(idx.files), "totalLines": sum(f.lines for f in idx.files),
            "languages": idx.languages(), "summary": idx.summary(),
        }  # fmt: skip

    async def get(self, repo_id: str) -> RepoIndex:
        root = self.path(repo_id)
        if repo_id in self._cache:
            return self._cache[repo_id]
        if not root.is_dir():
            raise not_found("repo_not_found", f"repository {repo_id} is not indexed")
        idx = await asyncio.to_thread(RepoIndex.from_dir, root)
        self._cache[repo_id] = idx
        return idx

    def delete(self, repo_id: str) -> None:
        root = self.path(repo_id)
        self._cache.pop(repo_id, None)
        if not root.is_dir():
            raise ApiError(404, "repo_not_found", f"repository {repo_id} is not indexed")
        shutil.rmtree(root, ignore_errors=True)
