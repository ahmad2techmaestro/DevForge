"""Git helpers. Tokens are passed via a per-command http.extraheader, never stored."""

from __future__ import annotations

import asyncio
import base64
import os
import shutil
from pathlib import Path

from app.errors import ApiError
from app.schemas import DiffFile
from app.security import basic_auth_secrets, redact

_BASE_ENV = {
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_CONFIG_NOSYSTEM": "1",
    "LC_ALL": "C",
}


# Windows needs SYSTEMROOT and friends: without them Winsock fails and git reports
# "getaddrinfo() thread failed to start". Proxy variables are kept so corporate networks work.
_KEEP = (
    "PATH", "HOME", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE",
    "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ALLUSERSPROFILE", "HOMEDRIVE", "HOMEPATH",
    "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES", "USERNAME", "USERDOMAIN",
)


def _env() -> dict[str, str]:
    keep = {k: v for k, v in os.environ.items() if k in _KEEP}
    base = dict(_BASE_ENV)
    if os.name == "nt":
        base.pop("GIT_CONFIG_NOSYSTEM", None)  # keep Git for Windows' system config (CA bundle, schannel)
    return {**keep, **base}


def auth_args(token: str | None) -> list[str]:
    if not token:
        return []
    b64 = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    return ["-c", f"http.extraheader=Authorization: Basic {b64}"]


async def git(
    cwd: Path | None,
    *args: str,
    token: str | None = None,
    check: bool = True,
    extra_env: dict[str, str] | None = None,
    timeout: float = 300.0,
) -> str:
    cmd = ["git", *auth_args(token), *args]
    env = {**_env(), **(extra_env or {})}
    proc = await asyncio.create_subprocess_exec(
        *cmd, cwd=cwd, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except TimeoutError:
        proc.kill()
        raise ApiError(504, "git_timeout", f"git {args[0]} timed out") from None
    if check and proc.returncode != 0:
        secrets = basic_auth_secrets(token) if token else []
        msg = redact(err.decode(errors="replace").strip(), secrets)
        raise ApiError(422, "git_failed", f"git {args[0]} failed: {msg[:500]}")
    return out.decode(errors="replace")


def _is_network_error(msg: str) -> bool:
    m = msg.lower()
    return any(k in m for k in ("getaddrinfo", "could not resolve host", "unable to access", "timed out", "connection reset"))


async def clone(url: str, dest: Path, branch: str | None, token: str | None) -> None:
    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    args = ["clone", "--quiet"]
    if branch:
        args += ["--branch", branch]
    last: ApiError | None = None
    for attempt in range(3):
        try:
            await git(None, *args, "--", url, str(dest), token=token)
            last = None
            break
        except ApiError as err:
            if not _is_network_error(str(err.message)):
                raise
            last = err
            if dest.exists():
                shutil.rmtree(dest, ignore_errors=True)
            await asyncio.sleep(1.5 * (attempt + 1))
    if last is not None:
        raise ApiError(
            422,
            "git_network",
            f"{last.message} (tried 3 times). This machine could not reach the git host. "
            "Check VPN/proxy/antivirus and run `git ls-remote <url>` in a terminal, "
            "or clone the repository yourself and connect it with the Local path option.",
        )
    # Defensive: make sure no credential ever lands in the on-disk config.
    await git(dest, "config", "--unset-all", "http.extraheader", check=False)


async def copy_local(src: Path, dest: Path, branch: str | None) -> None:
    """Clone a local git repo (preserving history), or copy a plain directory."""
    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if (src / ".git").exists():
        args = ["clone", "--quiet", "--no-hardlinks"]
        if branch:
            args += ["--branch", branch]
        await git(None, *args, "--", str(src), str(dest))
    else:
        shutil.copytree(src, dest, ignore=shutil.ignore_patterns(".git", "node_modules", ".venv"))
        await init_repo(dest)


async def init_repo(path: Path) -> None:
    await git(path, "init", "--quiet")
    await commit_all(path, "Initial snapshot", "DevForge", "devforge@localhost", branch=None)


async def head_commit(path: Path) -> str:
    return (await git(path, "rev-parse", "HEAD", check=False)).strip()


async def current_branch(path: Path) -> str:
    return (await git(path, "rev-parse", "--abbrev-ref", "HEAD", check=False)).strip() or "main"


async def commit_all(
    path: Path, message: str, name: str, email: str, branch: str | None
) -> str:
    ident = ["-c", f"user.name={name}", "-c", f"user.email={email}", "-c", "commit.gpgsign=false"]
    if branch:
        await git(path, "checkout", "-B", branch)
    await git(path, "add", "-A")
    await git(path, *ident, "commit", "--quiet", "--allow-empty", "-m", message)
    return await head_commit(path)


def parse_numstat(numstat: str, name_status: str) -> list[DiffFile]:
    status: dict[str, str] = {}
    for line in name_status.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            code = parts[0][0]
            status[parts[-1]] = {"A": "added", "D": "deleted"}.get(code, "modified")
    files: list[DiffFile] = []
    for line in numstat.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        add = int(parts[0]) if parts[0].isdigit() else 0
        dele = int(parts[1]) if parts[1].isdigit() else 0
        path = parts[2]
        files.append(DiffFile(path=path, status=status.get(path, "modified"), additions=add, deletions=dele))
    return files


async def working_diff(path: Path, base: str = "HEAD") -> tuple[str, list[DiffFile]]:
    """Diff of the working tree (incl. untracked files) against `base`."""
    await git(path, "add", "-A", "-N")  # intent-to-add so new files appear in diff
    diff = await git(path, "diff", "--no-color", "--no-ext-diff", base)
    numstat = await git(path, "diff", "--numstat", base)
    names = await git(path, "diff", "--name-status", base)
    return diff, parse_numstat(numstat, names)
