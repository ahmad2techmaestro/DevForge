from __future__ import annotations

from app.repo.risk import added_lines, parse_diff, score_diff
from app.schemas import DiffFile


def f(path: str, add: int = 5, dele: int = 0, status: str = "modified") -> DiffFile:
    return DiffFile(path=path, status=status, additions=add, deletions=dele)  # type: ignore[arg-type]


def test_small_change_is_low() -> None:
    r = score_diff([f("src/a.py"), f("tests/test_a.py")])
    assert r.level == "low" and r.score < 30


def test_sensitive_paths_and_missing_tests_raise_risk() -> None:
    r = score_diff([f("src/auth/login.py"), f("migrations/001.sql"), f(".github/workflows/ci.yml"),
                    f("Dockerfile"), f("package-lock.json", 500, 400)])  # fmt: skip
    assert r.level == "high"
    text = " ".join(r.reasons)
    for needle in ("auth", "migrations", "CI", "Dockerfile", "lockfile", "without any test"):
        assert needle in text


def test_deletions_increase_risk() -> None:
    a = score_diff([f("src/x.py", 1, 5)]).score
    b = score_diff([f("src/x.py", 0, 0, "deleted"), f("tests/t_x.py")]).score
    assert b > 0 and a >= 0
    assert score_diff([]).score == 0


def test_parse_diff_and_added_lines() -> None:
    diff = (
        "diff --git a/a.py b/a.py\nindex 1..2 100644\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,3 @@\n x\n+y\n z\n-w\n"
        "diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+hi\n"
    )
    files = {x.path: x for x in parse_diff(diff)}
    assert files["a.py"].additions == 1 and files["a.py"].deletions == 1
    assert files["n.txt"].status == "added"
    assert added_lines(diff) == {"a.py": {2: "y"}, "n.txt": {1: "hi"}}
