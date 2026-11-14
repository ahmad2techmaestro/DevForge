from pathlib import Path

from app.errors import ApiError
from app.repo import files as files_mod
from app.repo.gitops import _friendly_clone_error
from app.repo.index import RepoIndex


def test_private_or_missing_repo_gets_a_plain_message() -> None:
    raw = ApiError(422, "git_failed", "git clone failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled")
    out = _friendly_clone_error(raw, has_token=False, branch=None)
    assert out.code == "repo_not_found"
    assert "add a GitHub token" in out.message and "terminal prompts" not in out.message
    assert "token was not accepted" in _friendly_clone_error(raw, has_token=True, branch=None).message


def test_missing_branch_is_named() -> None:
    raw = ApiError(422, "git_failed", "git clone failed: fatal: Remote branch dev not found in upstream origin")
    out = _friendly_clone_error(raw, has_token=False, branch="dev")
    assert out.code == "branch_not_found" and "'dev'" in out.message


def test_other_errors_pass_through() -> None:
    raw = ApiError(422, "git_failed", "git clone failed: something else")
    assert _friendly_clone_error(raw, has_token=False, branch=None) is raw


def test_size_limit_truncates_and_says_so(tmp_path: Path, monkeypatch) -> None:
    for i in range(6):
        (tmp_path / f"f{i}.py").write_text(f"x = {i}\n")
    monkeypatch.setattr(files_mod, "MAX_FILES", 3)
    idx = RepoIndex.from_dir(tmp_path)
    assert len(idx.files) == 3 and idx.truncated
    assert "size limit" in idx.summary()


def test_small_repo_is_not_truncated(tmp_path: Path) -> None:
    (tmp_path / "a.py").write_text("x = 1\n")
    idx = RepoIndex.from_dir(tmp_path)
    assert not idx.truncated and "size limit" not in idx.summary()
