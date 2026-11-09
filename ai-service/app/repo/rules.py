"""Static bug rules (Python via ast + regex; JS/TS via regex) and long-function detection."""

from __future__ import annotations

import ast
import re

from app.schemas import Finding, Severity
from app.security import scan_line

LONG_FUNCTION_LINES = 60


def _f(path: str, line: int, sev: Severity, rule: str, title: str, detail: str, fix: str = "") -> Finding:
    return Finding(path=path, line=line, severity=sev, rule=rule, title=title, detail=detail,
                   suggestion=fix or None)  # fmt: skip


_SQL_FMT = re.compile(
    r"""(?i)(execute|executemany|query|raw)\s*\(\s*(f["']|["'][^"']*(select|insert|update|delete)[^"']*["']\s*(%|\.format|\+))"""
)
_SQL_FSTRING = re.compile(r"""(?i)\bf["'][^"']*\b(select|insert into|update|delete from)\b[^"']*\{""")


def python_functions(tree: ast.AST) -> list[tuple[str, int, int]]:
    out: list[tuple[str, int, int]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            end = node.end_lineno or node.lineno
            out.append((node.name, node.lineno, end - node.lineno + 1))
    return out


def _unreachable(path: str, body: list[ast.stmt], out: list[Finding]) -> None:
    for i, stmt in enumerate(body[:-1]):
        if isinstance(stmt, ast.Return | ast.Raise | ast.Continue | ast.Break):
            nxt = body[i + 1]
            out.append(_f(path, nxt.lineno, "medium", "py-unreachable-code", "Unreachable code",
                          "Statement follows return/raise/continue/break and can never run.",
                          "Remove the dead code or fix the control flow."))  # fmt: skip
            break


def analyze_python(path: str, text: str) -> list[Finding]:
    out: list[Finding] = []
    try:
        tree = ast.parse(text)
    except SyntaxError as e:
        return [_f(path, e.lineno or 1, "high", "py-syntax-error", "Syntax error", str(e.msg))]
    for node in ast.walk(tree):
        if isinstance(node, ast.ExceptHandler) and node.type is None:
            out.append(_f(path, node.lineno, "medium", "py-bare-except", "Bare except",
                          "`except:` also catches KeyboardInterrupt/SystemExit and hides bugs.",
                          "Catch specific exceptions (or `Exception`)."))  # fmt: skip
        elif isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda):
            defaults = [*node.args.defaults, *[d for d in node.args.kw_defaults if d is not None]]
            for d in defaults:
                if isinstance(d, ast.List | ast.Dict | ast.Set) or (
                    isinstance(d, ast.Call) and isinstance(d.func, ast.Name)
                    and d.func.id in ("list", "dict", "set")
                ):
                    out.append(_f(path, d.lineno, "medium", "py-mutable-default",
                                  "Mutable default argument",
                                  "Default is created once and shared between calls.",
                                  "Use `None` and create the value inside the function."))  # fmt: skip
        elif isinstance(node, ast.Call):
            fn = node.func
            if isinstance(fn, ast.Name) and fn.id in ("eval", "exec"):
                out.append(_f(path, node.lineno, "high", "py-eval-exec", f"Use of {fn.id}()",
                              "Executing dynamic code is a code-injection risk.",
                              "Use ast.literal_eval or an explicit dispatch table."))  # fmt: skip
            for kw in node.keywords:
                if (kw.arg == "shell" and isinstance(kw.value, ast.Constant) and kw.value.value is True
                        and isinstance(fn, ast.Attribute) and isinstance(fn.value, ast.Name)
                        and fn.value.id == "subprocess"):  # fmt: skip
                    out.append(_f(path, node.lineno, "high", "py-subprocess-shell",
                                  "subprocess with shell=True",
                                  "Shell interpretation enables command injection.",
                                  "Pass an argument list and drop shell=True."))  # fmt: skip
        elif isinstance(node, ast.Compare):
            for op, right in zip(node.ops, node.comparators, strict=False):
                if isinstance(op, ast.Eq | ast.NotEq) and isinstance(right, ast.Constant) and right.value is None:
                    out.append(_f(path, node.lineno, "low", "py-eq-none", "Comparison to None with ==",
                                  "Use identity comparison for None.", "Use `is None` / `is not None`."))  # fmt: skip
        if hasattr(node, "body") and isinstance(getattr(node, "body", None), list):
            _unreachable(path, node.body, out)  # type: ignore[arg-type]
        for attr in ("orelse", "finalbody"):
            block = getattr(node, attr, None)
            if isinstance(block, list) and block and isinstance(block[0], ast.stmt):
                _unreachable(path, block, out)
    for i, line in enumerate(text.splitlines(), 1):
        if _SQL_FMT.search(line) or _SQL_FSTRING.search(line):
            out.append(_f(path, i, "high", "sql-string-format", "SQL built with string formatting",
                          "Interpolating values into SQL enables injection.",
                          "Use parameterized queries."))  # fmt: skip
    return out


_JS_RULES: list[tuple[re.Pattern[str], Severity, str, str, str]] = [
    (re.compile(r"[^=!<>]==[^=]|!=[^=]"), "low", "js-loose-equality", "Loose equality",
     "`==`/`!=` perform type coercion; prefer `===`/`!==`."),
    (re.compile(r"\bconsole\.(log|debug)\("), "info", "js-console-log", "console.log left in code",
     "Debug logging probably should not ship."),
    (re.compile(r"\beval\s*\("), "high", "js-eval", "Use of eval()",
     "Executing dynamic code is a code-injection risk."),
    (re.compile(r"\.innerHTML\s*="), "medium", "js-innerhtml", "Assignment to innerHTML",
     "Can lead to XSS when the value is user-controlled."),
]  # fmt: skip


def _strip_js_noise(line: str) -> str:
    line = re.sub(r"""(["'`])(?:\\.|(?!\1).)*\1""", '""', line)
    return re.sub(r"//.*$", "", line)


def analyze_js(path: str, text: str) -> list[Finding]:
    out: list[Finding] = []
    for i, raw in enumerate(text.splitlines(), 1):
        line = _strip_js_noise(raw)
        if not line.strip():
            continue
        for pat, sev, rule, title, detail in _JS_RULES:
            if pat.search(line):
                out.append(_f(path, i, sev, rule, title, detail))
    return out


def analyze_secrets(path: str, text: str) -> list[Finding]:
    out: list[Finding] = []
    for i, line in enumerate(text.splitlines(), 1):
        rule = scan_line(line)
        if rule:
            out.append(_f(path, i, "critical", "hardcoded-secret", "Possible hardcoded secret",
                          f"Line looks like a credential ({rule}). Value not shown.",
                          "Move it to an environment variable / secret manager and rotate it."))  # fmt: skip
    return out


def analyze_file(path: str, language: str, text: str, secrets: bool = True) -> list[Finding]:
    out: list[Finding] = []
    if language == "Python":
        out += analyze_python(path, text)
    elif language in ("JavaScript", "TypeScript"):
        out += analyze_js(path, text)
    if secrets and language not in ("Markdown",):
        out += analyze_secrets(path, text)
    return out
