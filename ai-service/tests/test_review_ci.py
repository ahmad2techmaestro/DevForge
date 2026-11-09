"""Diff parser, PR review route and CI-log analysis."""

from __future__ import annotations

import httpx

from app.repo.cilog import analyze_log, strip_noise
from app.repo.diffparse import map_comment_line, parse_unified_diff, resolve_file, truncate_diff
from tests.conftest import running

DIFF = """\
diff --git a/app/a.py b/app/a.py
index 111..222 100644
--- a/app/a.py
+++ b/app/a.py
@@ -1,4 +1,5 @@
 import os
+import yaml

 def f(x):
-    return x
+    return yaml.load(x)
@@ -20,3 +21,4 @@ def g():
     a = 1
     b = 2
+    c = 3
     return a
diff --git a/old.txt b/new.txt
similarity index 90%
rename from old.txt
rename to new.txt
index 333..444 100644
--- a/old.txt
+++ b/new.txt
@@ -1 +1 @@
-hello
+hello world
\\ No newline at end of file
diff --git a/gone.py b/gone.py
deleted file mode 100644
index 555..000
--- a/gone.py
+++ /dev/null
@@ -1,2 +0,0 @@
-x = 1
-y = 2
diff --git a/fresh.py b/fresh.py
new file mode 100644
--- /dev/null
+++ b/fresh.py
@@ -0,0 +1,2 @@
+API = 1
+eval(input())
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
"""


def test_parser_files_hunks_and_lines() -> None:
    files = parse_unified_diff(DIFF)
    assert [f.path for f in files] == ["app/a.py", "new.txt", "gone.py", "fresh.py", "img.png"]
    a, ren, gone, fresh, img = files
    assert len(a.hunks) == 2 and a.status == "modified"
    assert a.right_lines() == {2, 5, 23}  # added lines only, with correct RIGHT numbering after offsets
    assert (a.additions, a.deletions) == (3, 1)
    assert a.added_lines()[5] == "    return yaml.load(x)"
    assert ren.status == "renamed" and ren.old_path == "old.txt" and ren.right_lines() == {1}
    assert ren.hunks[0].lines[-1].text == "hello world"  # no-newline marker is not a line
    assert gone.status == "deleted" and gone.right_lines() == set() and gone.deletions == 2
    assert fresh.status == "added" and fresh.right_lines() == {1, 2}
    assert img.binary and not img.hunks


def test_parser_plain_unified_diff_and_crlf() -> None:
    plain = "--- a/x.py\r\n+++ b/x.py\r\n@@ -1,2 +1,3 @@\r\n a\r\n+b\r\n c\r\n--- a/y.py\r\n+++ b/y.py\r\n@@ -5 +5 @@\r\n-q\r\n+r\r\n"
    files = parse_unified_diff(plain)
    assert [f.path for f in files] == ["x.py", "y.py"]
    assert files[0].right_lines() == {2} and files[1].right_lines() == {5}
    assert parse_unified_diff("") == [] and parse_unified_diff("garbage\nlines") == []


def test_parser_content_lines_that_look_like_headers() -> None:
    diff = "diff --git a/n.md b/n.md\n--- a/n.md\n+++ b/n.md\n@@ -1,2 +1,2 @@\n--- not a header\n+++ also content\n ctx\n"
    (f,) = parse_unified_diff(diff)
    assert f.additions == 1 and f.deletions == 1 and f.right_lines() == {1}


def test_comment_line_mapping() -> None:
    files = parse_unified_diff(DIFF)
    a = files[0]
    assert map_comment_line(a, 5) == 5  # exact added line
    assert map_comment_line(a, 4) == 5  # context line relocated to the nearest added line in the hunk
    assert map_comment_line(a, 12) is None  # between hunks
    assert map_comment_line(a, 500) is None
    assert resolve_file(files, "b/app/a.py") is a and resolve_file(files, "./app\\a.py") is a
    assert resolve_file(files, "a.py") is a  # unique suffix
    assert resolve_file(files, "gone.py") is None  # deleted: no RIGHT side
    assert resolve_file(files, "nope.py") is None


def test_truncate_diff_per_file_budget() -> None:
    big = "diff --git a/big.py b/big.py\n--- a/big.py\n+++ b/big.py\n" + "".join(
        f"@@ -{i*10},1 +{i*10},1 @@\n-a\n+{'x' * 200}\n" for i in range(1, 200)
    )
    small = "diff --git a/s.py b/s.py\n--- a/s.py\n+++ b/s.py\n@@ -1 +1 @@\n-a\n+b\n"
    text, cut = truncate_diff(big + small, per_file=2000, total=10_000)
    assert cut == ["big.py"] and "diff --git a/s.py" in text and "truncated" in text
    assert len(text) < 3000
    parsed = parse_unified_diff(text)
    assert [f.path for f in parsed] == ["big.py", "s.py"]
    _, cut = truncate_diff(big * 1 + small * 1, per_file=100_000, total=500)
    assert cut  # total budget omits later content


# ---- route ------------------------------------------------------------------------------------------


async def test_review_route_maps_comments(settings) -> None:
    async with running(settings) as (c, _):
        r = await c.post("/reviews/pr", json={"title": "Tweak", "diff": DIFF})
        assert r.status_code == 200, r.text
        body = r.json()
        assert set(body) >= {"summary", "verdict", "riskScore", "comments", "stats"}
        assert body["stats"]["files"] == 5 and body["stats"]["additions"] == 6 and body["stats"]["deletions"] == 4
        valid = {f.path: f.right_lines() for f in parse_unified_diff(DIFF)}
        assert body["comments"], "static rules should flag yaml.load / eval"
        for cm in body["comments"]:
            assert cm["side"] == "RIGHT" and cm["line"] in valid[cm["path"]]
            assert cm["severity"] in ("info", "low", "medium", "high")
        rules = {(cm["path"], cm["line"]) for cm in body["comments"]}
        assert ("app/a.py", 5) in rules and ("fresh.py", 2) in rules
        assert body["verdict"] == "request_changes" and body["riskScore"] in ("low", "medium", "high")
        assert body["summary"].startswith("PR “Tweak”")

        clean = "diff --git a/t.md b/t.md\n--- a/t.md\n+++ b/t.md\n@@ -1 +1 @@\n-a\n+b\n"
        ok = (await c.post("/reviews/pr", json={"diff": clean})).json()
        assert ok["verdict"] == "approve" and ok["comments"] == [] and ok["riskScore"] == "low"

        bad = await c.post("/reviews/pr", json={"diff": "nothing to see"})
        assert bad.status_code == 400 and bad.json()["error"]["code"] == "empty_diff"
        assert (await c.post("/reviews/pr", json={})).status_code == 400


async def test_review_drops_comments_outside_diff(settings) -> None:
    from app.llm.base import ReviewResult
    from app.llm.mock import MockBrain
    from app.schemas import ReviewComment

    class Brain(MockBrain):
        async def review(self, diff, index):  # type: ignore[no-untyped-def]
            cs = [
                ReviewComment(path="app/a.py", line=4, severity="medium", body="near the change"),
                ReviewComment(path="app/a.py", line=12, severity="high", body="outside every hunk"),
                ReviewComment(path="other.py", line=1, severity="high", body="file not in diff"),
                ReviewComment(path="gone.py", line=1, severity="low", body="deleted file"),
            ]
            return ReviewResult("llm summary", cs)

    async with running(settings, brain_factory=lambda m: Brain(m)) as (c, _):
        body = (await c.post("/reviews/pr", json={"diff": DIFF})).json()
    texts = {cm["body"]: cm for cm in body["comments"]}
    assert texts["near the change"]["line"] == 5
    assert "outside every hunk" not in texts and "file not in diff" not in texts and "deleted file" not in texts
    assert body["stats"]["droppedComments"] == 3 and body["stats"]["relocatedComments"] >= 1
    assert "llm summary" in body["summary"]


async def test_new_routes_require_key(settings) -> None:
    async with running(settings) as (c, app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agent") as anon:
            for path, payload in (("/reviews/pr", {"diff": DIFF}), ("/ci/analyze", {"log": "x"})):
                r = await anon.post(path, json=payload)
                assert r.status_code == 401 and r.json()["error"]["code"] == "unauthorized"
                r = await anon.post(path, json=payload, headers={"X-Internal-Key": "wrong"})
                assert r.status_code == 401


# ---- CI log parsing ---------------------------------------------------------------------------------

PYTEST_LOG = """\
2024-05-01T10:00:00.1234567Z ============================= test session starts ==============================
2024-05-01T10:00:01.0000000Z \x1b[31mFAILED\x1b[0m tests/test_calc.py::test_add - assert 3 == 4
=================================== FAILURES ===================================
___________________________________ test_add ___________________________________

    def test_add():
>       assert add(1, 2) == 4
E       assert 3 == 4
E        +  where 3 = add(1, 2)

tests/test_calc.py:5: AssertionError
/home/runner/work/proj/proj/calc/ops.py:12: ValueError
=========================== short test summary info ============================
FAILED tests/test_calc.py::test_add - assert 3 == 4
FAILED tests/test_calc.py::test_sub[neg] - AssertionError
========================= 2 failed, 5 passed in 0.31s ==========================
##[error]Process completed with exit code 1.
"""


def test_ci_pytest() -> None:
    a = analyze_log(PYTEST_LOG)
    assert a.kind == "test" and "pytest" in a.tools
    assert a.failing_tests == ["tests/test_calc.py::test_add", "tests/test_calc.py::test_sub[neg]"]
    assert "tests/test_calc.py" in a.files and "calc/ops.py" in a.files
    assert any("assert 3 == 4" in e for e in a.error_lines)
    assert "\x1b" not in strip_noise(PYTEST_LOG) and "2024-05-01T" not in strip_noise(PYTEST_LOG)


def test_ci_vitest() -> None:
    log = """
 ❯ src/math.test.ts (2 tests | 1 failed) 5ms
   × math > adds numbers 2ms
 FAIL  src/math.test.ts > math > adds numbers
AssertionError: expected 3 to be 4 // Object.is equality
 ❯ src/math.test.ts:6:21
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
"""
    a = analyze_log(log)
    assert a.kind == "test" and "jest/vitest" in a.tools
    assert "src/math.test.ts > math > adds numbers" in a.failing_tests
    assert a.files[0] == "src/math.test.ts" and any("expected 3 to be 4" in e for e in a.error_lines)


def test_ci_tsc_ruff_eslint_go() -> None:
    tsc = analyze_log("src/app.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error.\n")
    assert tsc.kind == "build" and tsc.files == ["src/app.ts"] and "TS2322" in tsc.error_lines[0]
    tsc2 = analyze_log("src/b.tsx:3:7 - error TS2304: Cannot find name 'x'.\n")
    assert tsc2.kind == "build" and tsc2.files == ["src/b.tsx"]

    ruff = analyze_log("app/x.py:3:8: F401 [*] `os` imported but unused\napp/y.py:9:1: E501 Line too long\nFound 2 errors.\n")
    assert ruff.kind == "lint" and ruff.files == ["app/x.py", "app/y.py"] and "F401" in ruff.error_lines[0]
    ruff_new = analyze_log("F401 [*] `os` imported but unused\n --> app/z.py:1:8\n  |\n1 | import os\n")
    assert ruff_new.kind == "lint" and ruff_new.files == ["app/z.py"]

    eslint = analyze_log("/work/repo/src/a.js\n  12:5  error  'x' is not defined  no-undef\n  14:1  warning  Unexpected  semi\n\n✖ 2 problems (1 error, 1 warning)\n")
    assert eslint.kind == "lint" and eslint.files and eslint.files[0].endswith("a.js") and "no-undef" in eslint.error_lines[0]

    go = analyze_log("=== RUN   TestSum\n    sum_test.go:14: got 3, want 4\n--- FAIL: TestSum (0.00s)\nFAIL\nFAIL\texample.com/m\t0.004s\n")
    assert go.kind == "test" and go.failing_tests == ["TestSum"] and go.files == ["sum_test.go"]
    gob = analyze_log("# example.com/m\n./main.go:7:2: undefined: foo\nFAIL\texample.com/m [build failed]\n")
    assert gob.kind == "build" and gob.files == ["main.go"]


def test_ci_maven_and_install() -> None:
    mvn = analyze_log(
        "[ERROR] Tests run: 3, Failures: 1, Errors: 0, Skipped: 0\n[ERROR] Failures: \n"
        "[ERROR]   CalcTest.testAdd:12 expected:<4> but was:<3>\n"
    )
    assert mvn.kind == "test" and mvn.failing_tests == ["CalcTest.testAdd"]
    comp = analyze_log("[ERROR] COMPILATION ERROR :\n[ERROR] /w/src/main/java/App.java:[10,5] cannot find symbol\n")
    assert comp.kind == "build" and comp.files == ["w/src/main/java/App.java"] or comp.files[0].endswith("App.java")
    npm = analyze_log("npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE could not resolve\nnpm ERR! Found: react@17.0.2\n")
    assert npm.kind == "install" and any("ERESOLVE" in e for e in npm.error_lines)
    pip = analyze_log("ERROR: Could not find a version that satisfies the requirement foo==9.9\nERROR: No matching distribution found for foo==9.9\n")
    assert pip.kind == "install"
    other = analyze_log("Error: something exploded\nprocess exited with exit code 3\n")
    assert other.kind == "other" and other.error_lines


def test_ci_size_cap_keeps_tail() -> None:
    log = "noise line\n" * 100_000 + "FAILED tests/test_tail.py::test_end - boom\n"
    a = analyze_log(log)
    assert a.failing_tests == ["tests/test_tail.py::test_end"]
    assert len(strip_noise(log)) <= 400_000


async def test_ci_route(settings) -> None:
    async with running(settings) as (c, _):
        r = await c.post("/ci/analyze", json={"log": PYTEST_LOG, "workflow": "CI", "jobName": "test"})
        assert r.status_code == 200, r.text
        b = r.json()
        assert b["failureKind"] == "test" and len(b["failingTests"]) == 2
        assert b["summary"].startswith("CI / test:") and "tests/test_calc.py" in b["suspectedFiles"]
        assert b["suggestedTask"]["title"].startswith("Fix failing tests") and "test_add" in b["suggestedTask"]["description"]
        assert (await c.post("/ci/analyze", json={"log": ""})).status_code == 400
