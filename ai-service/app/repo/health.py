"""Code health score (0-100, A-F) from static metrics."""

from __future__ import annotations

import ast
import re

from app.repo.files import CODE_LANGUAGES, FileInfo, is_test_path
from app.repo.rules import LONG_FUNCTION_LINES, analyze_secrets, python_functions
from app.schemas import Finding

_TODO = re.compile(r"\b(TODO|FIXME|HACK|XXX)\b")
_JS_FUNC = re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)|^\s*(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(.*\)\s*=>\s*\{")
LARGE_FILE_LINES = 500


def _js_long_functions(path: str, text: str) -> list[Finding]:
    out: list[Finding] = []
    lines = text.splitlines()
    for i, line in enumerate(lines):
        m = _JS_FUNC.match(line)
        if not m:
            continue
        depth, seen, end = 0, False, i
        for j in range(i, len(lines)):
            depth += lines[j].count("{") - lines[j].count("}")
            seen = seen or "{" in lines[j]
            if seen and depth <= 0:
                end = j
                break
        else:
            continue
        if end - i + 1 > LONG_FUNCTION_LINES:
            out.append(_long(path, i + 1, m.group(1) or m.group(2), end - i + 1))
    return out


def _long(path: str, line: int, name: str, n: int) -> Finding:
    return Finding(path=path, line=line, severity="low", rule="long-function",
                   title=f"Long function `{name}`", detail=f"{n} lines (limit {LONG_FUNCTION_LINES}).",
                   suggestion="Split into smaller functions.")  # fmt: skip


def compute_health(files: list[FileInfo], texts: dict[str, str]) -> dict[str, object]:
    findings: list[Finding] = []
    todo = long_fn = secrets = large = 0
    test_files = sum(1 for f in files if is_test_path(f.path) and f.language in CODE_LANGUAGES)
    code_files = [f for f in files if f.language in CODE_LANGUAGES]
    for f in files:
        text = texts.get(f.path, "")
        todo += len(_TODO.findall(text))
        if f.language in ("Markdown", "Text"):
            continue
        sec = analyze_secrets(f.path, text)
        secrets += len(sec)
        findings += sec
        if f.lines > LARGE_FILE_LINES and f.language in CODE_LANGUAGES:
            large += 1
            findings.append(Finding(path=f.path, line=1, severity="low", rule="large-file",
                                    title="Large file", detail=f"{f.lines} lines.",
                                    suggestion="Consider splitting by responsibility."))  # fmt: skip
        if f.language == "Python":
            try:
                for name, line, n in python_functions(ast.parse(text)):
                    if n > LONG_FUNCTION_LINES:
                        long_fn += 1
                        findings.append(_long(f.path, line, name, n))
            except SyntaxError:
                continue
        elif f.language in ("JavaScript", "TypeScript"):
            lf = _js_long_functions(f.path, text)
            long_fn += len(lf)
            findings += lf
    n_code = len(code_files)
    non_test_code = max(n_code - test_files, 0)
    ratio = round(test_files / non_test_code, 2) if non_test_code else 0.0
    if non_test_code and test_files == 0:
        findings.append(Finding(path=".", line=1, severity="medium", rule="no-tests", title="No tests found",
                                detail="The repository has code but no test files.",
                                suggestion="Add unit tests for core modules."))  # fmt: skip
    total_lines = sum(f.lines for f in files)
    score = 100.0
    score -= min(secrets * 10, 30)
    score -= min(long_fn * 3, 15)
    score -= min(large * 3, 10)
    score -= min(todo * 0.5, 10)
    score -= 0 if ratio >= 0.5 else (25 if ratio == 0 and non_test_code else (1 - ratio / 0.5) * 20)
    score = max(0, min(100, round(score)))
    grade = "A" if score >= 90 else "B" if score >= 80 else "C" if score >= 70 else "D" if score >= 60 else "F"
    return {
        "score": score,
        "grade": grade,
        "metrics": {
            "files": len(files), "lines": total_lines, "testFiles": test_files, "testRatio": ratio,
            "todoCount": todo, "avgFileLines": round(total_lines / len(files), 1) if files else 0,
            "largeFiles": large, "longFunctions": long_fn, "secretsFound": secrets,
        },
        "findings": [f.model_dump(exclude_none=True) for f in findings[:200]],
    }  # fmt: skip
