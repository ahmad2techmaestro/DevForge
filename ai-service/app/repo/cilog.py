"""Deterministic CI-log analysis: pytest, jest/vitest, tsc, eslint, ruff, go test, maven, npm/pip installs."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

MAX_LOG_CHARS = 400_000  # keep the tail: failures are reported last
MAX_LIST = 20

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")
_TS = re.compile(r"^\d{4}-\d\d-\d\dT[\d:.]+Z ?")
_GH = re.compile(r"^##\[(?:error|warning|group|endgroup|debug)\]\s?")
_SRC_EXT = r"(?:py|pyi|[cm]?[jt]sx?|go|rs|java|kt|rb|php|vue|svelte|cs|c|cc|cpp|h|hpp)"
_PATH = rf"[\w@./\\ -]*?[\w@.-]+\.{_SRC_EXT}"
_NOISE = re.compile(r"(site-packages|node_modules|/usr/lib|/opt/hostedtoolcache|\.venv/|<frozen|/_pytest/|/pluggy/|GOROOT|/go/pkg/mod/)")


def strip_noise(log: str) -> str:
    """Remove ANSI escapes, CI timestamps and `##[error]` markers; keep only the tail if huge."""
    if len(log) > MAX_LOG_CHARS:
        log = log[-MAX_LOG_CHARS:]
        log = log.split("\n", 1)[-1]  # drop the partial first line
    lines = []
    for raw in _ANSI.sub("", log).replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        lines.append(_GH.sub("", _TS.sub("", raw)).rstrip())
    return "\n".join(lines)


@dataclass(slots=True)
class CiAnalysis:
    kind: str = "other"  # test | lint | build | install | other
    tools: list[str] = field(default_factory=list)
    failing_tests: list[str] = field(default_factory=list)
    error_lines: list[str] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)
    flags: set[str] = field(default_factory=set)

    def add_test(self, name: str) -> None:
        name = name.strip()
        if name and name not in self.failing_tests:
            self.failing_tests.append(name)

    def add_error(self, line: str) -> None:
        line = line.strip()[:300]
        if line and line not in self.error_lines:
            self.error_lines.append(line)

    def add_file(self, path: str) -> None:
        p = clean_file(path)
        if p and p not in self.files:
            self.files.append(p)


def clean_file(path: str) -> str | None:
    p = path.strip().strip("'\"()[]:").replace("\\", "/")
    if not p or _NOISE.search(p) or not re.search(rf"\.{_SRC_EXT}$", p):
        return None
    if p.startswith("/") and "/work/" in p:  # /home/runner/work/<repo>/<repo>/src/x.py -> src/x.py
        rest = p.split("/work/", 1)[1].split("/")
        if len(rest) > 2:
            p = "/".join(rest[2:])
    while p.startswith("./"):
        p = p[2:]
    return p


# ---- per-tool parsers -------------------------------------------------------------------------------


def _pytest(lines: list[str], a: CiAnalysis) -> None:
    hit = False
    for ln in lines:
        m = re.match(rf"^(FAILED|ERROR)\s+({_PATH}(?:::[\w\[\]\-.,:<>/ ]+?)?)(?:\s+-\s+(.*))?$", ln)
        if m:
            hit = True
            a.add_test(m.group(2).strip())
            a.add_file(m.group(2).split("::", 1)[0])
            if m.group(3):
                a.add_error(m.group(3))
            continue
        if re.match(r"^E\s{2,}\S", ln):
            hit = True
            a.add_error(ln[1:].strip())
        m = re.match(rf"^({_PATH}):(\d+): (?:\w*Error|\w*Exception|AssertionError|Failed)", ln)
        if m:
            a.add_file(m.group(1))
        m = re.match(r"^=+ (.*\b(?:failed|error|errors)\b.*) in [\d.]+s", ln)
        if m:
            hit = True
            a.counts["failed"] = int(n.group(1)) if (n := re.search(r"(\d+) failed", m.group(1))) else 0
    if hit or any("=== FAILURES ===" in ln or "short test summary info" in ln for ln in lines):
        a.tools.append("pytest")
        a.flags.add("test")


def _jest_vitest(lines: list[str], a: CiAnalysis) -> None:
    hit = False
    for ln in lines:
        m = re.match(r"^\s*(?:FAIL|×|✗|✕)\s+(.+?\.(?:test|spec)\.[cm]?[jt]sx?)(?:\s+[>›]\s+(.+?))?(?:\s+\d+ms)?$", ln)
        if m:
            hit = True
            a.add_file(m.group(1).strip())
            if m.group(2):
                a.add_test(f"{m.group(1).strip()} > {m.group(2).strip()}")
            continue
        m = re.match(r"^\s*●\s+(.+?)\s+›\s+(.+)$", ln)  # jest
        if m:
            hit = True
            a.add_test(f"{m.group(1)} > {m.group(2)}")
            continue
        m = re.match(r"^\s*(?:AssertionError|TypeError|ReferenceError|Error|expect\(.*\)\.\w+)[:(].*", ln)
        if m and ("expected" in ln or "Error" in ln):
            a.add_error(ln)
        m = re.match(rf"^\s*(?:❯|at)\s+(?:.*\()?({_PATH}):\d+(?::\d+)?\)?", ln)
        if m:
            a.add_file(m.group(1))
        if re.match(r"^\s*(Tests|Test Files)\s+.*\bfailed\b", ln):
            hit = True
    if hit:
        a.tools.append("jest/vitest")
        a.flags.add("test")


def _tsc(lines: list[str], a: CiAnalysis) -> None:
    hit = False
    for ln in lines:
        m = re.match(rf"^({_PATH})(?:\((\d+),\d+\)|:(\d+):\d+)\s*[:-]\s*error (TS\d+): (.*)$", ln.strip())
        if m:
            hit = True
            a.add_file(m.group(1))
            a.add_error(f"{m.group(1)}:{m.group(2) or m.group(3)} {m.group(4)}: {m.group(5)}")
    if hit:
        a.tools.append("tsc")
        a.flags.add("build")


def _eslint(lines: list[str], a: CiAnalysis) -> None:
    hit = False
    cur: str | None = None
    for ln in lines:
        if re.match(rf"^(?:/|\./|[A-Za-z]:[\\/])?{_PATH}$", ln) and not ln.startswith(" "):
            cur = ln
            continue
        m = re.match(r"^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}([@\w/-]+)$", ln)
        if m and cur:
            hit = True
            if m.group(3) == "error":
                a.add_file(cur)
                a.add_error(f"{cur}:{m.group(1)} {m.group(4)} ({m.group(5)})")
    if hit or any(re.match(r"^✖ \d+ problems? \(\d+ errors?", ln) for ln in lines):
        a.tools.append("eslint")
        a.flags.add("lint")


def _ruff(lines: list[str], a: CiAnalysis) -> None:
    hit = False
    for i, ln in enumerate(lines):
        m = re.match(rf"^({_PATH}):(\d+):(\d+): ([A-Z]{{1,4}}\d{{2,4}})\s+(?:\[\*\]\s+)?(.*)$", ln)
        if m:
            hit = True
            a.add_file(m.group(1))
            a.add_error(f"{m.group(1)}:{m.group(2)} {m.group(4)} {m.group(5)}")
            continue
        m = re.match(r"^([A-Z]{1,4}\d{2,4})\s+(?:\[\*\]\s+)?(.+)$", ln)  # newer "full" format
        if m and i + 1 < len(lines):
            n = re.match(rf"^\s*-->\s+({_PATH}):(\d+):\d+", lines[i + 1])
            if n:
                hit = True
                a.add_file(n.group(1))
                a.add_error(f"{n.group(1)}:{n.group(2)} {m.group(1)} {m.group(2)}")
    if hit or any(re.match(r"^Found \d+ errors?\.", ln) for ln in lines):
        a.tools.append("ruff")
        a.flags.add("lint")


def _go(lines: list[str], a: CiAnalysis) -> None:
    hit = build = False
    for ln in lines:
        m = re.match(r"^\s*--- FAIL: (\S+)", ln)
        if m:
            hit = True
            a.add_test(m.group(1))
            continue
        m = re.match(r"^\s+(\S+\.go):(\d+):\s*(.*)$", ln)
        if m:
            hit = True
            a.add_file(m.group(1))
            a.add_error(f"{m.group(1)}:{m.group(2)} {m.group(3)}")
            continue
        m = re.match(r"^(?:\./)?(\S+\.go):(\d+):(\d+): (.*)$", ln)
        if m:
            build = True
            a.add_file(m.group(1))
            a.add_error(f"{m.group(1)}:{m.group(2)} {m.group(4)}")
            continue
        if re.match(r"^FAIL\s+\S+(\s+[\d.]+s|\s+\[build failed\])", ln):
            hit = True
            if "[build failed]" in ln:
                build = True
    if build:
        a.tools.append("go build")
        a.flags.add("build")
    if hit:
        a.tools.append("go test")
        if not build:
            a.flags.add("test")


def _maven(lines: list[str], a: CiAnalysis) -> None:
    hit = compile_err = False
    for ln in lines:
        m = re.match(rf"^\[ERROR\]\s+({_PATH}):\[(\d+),\d+\]\s+(.*)$", ln)
        if m:
            compile_err = hit = True
            a.add_file(m.group(1))
            a.add_error(f"{m.group(1)}:{m.group(2)} {m.group(3)}")
            continue
        m = re.match(r"^\[ERROR\]\s+(\w[\w.$]*(?:Test|Tests|IT)\w*)\.(\w+):(\d+)\s*(.*)$", ln)
        if m:
            hit = True
            a.add_test(f"{m.group(1)}.{m.group(2)}")
            a.add_error(f"{m.group(1)}.{m.group(2)}:{m.group(3)} {m.group(4)}")
            continue
        m = re.match(r"^\[ERROR\] (?:Tests run:.*(?:Failures: [1-9]|Errors: [1-9])|Failed to execute goal .*)", ln)
        if m:
            hit = True
            a.add_error(ln.replace("[ERROR]", "").strip())
        m = re.match(r"^\[ERROR\] Failed to execute goal .*maven-compiler-plugin", ln)
        if m or "COMPILATION ERROR" in ln:
            compile_err = hit = True
    if hit:
        a.tools.append("maven")
        a.flags.add("build" if compile_err else "test")


def _install(lines: list[str], a: CiAnalysis) -> None:
    hit = False
    for ln in lines:
        m = re.match(r"^npm (?:ERR!|error) (.*)$", ln)
        if m:
            body = m.group(1).strip()
            if re.match(r"^(code |E[A-Z0-9]+|ERESOLVE|404|Could not resolve|peer dep|Found:|Conflicting|network|notarget|enoent|syscall|path )", body, re.I) or "ERESOLVE" in body:
                hit = True
                a.add_error("npm: " + body)
            continue
        if re.match(r"^ERROR: (Could not find a version|No matching distribution|Could not build wheels|Failed building wheel|Cannot install|THESE PACKAGES DO NOT MATCH)", ln) or re.match(
            r"^ERROR: Could not install packages", ln
        ):
            hit = True
            a.add_error(ln)
        if re.match(r"^(error: failed to (?:select a version|get)|go: .*(?:unknown revision|cannot find module|missing go.sum))", ln):
            hit = True
            a.add_error(ln)
        if re.match(r"^(yarn|pnpm)\b.*\b(ERR_PNPM_\w+|error An unexpected error)", ln) or "ERR_PNPM_" in ln:
            hit = True
            a.add_error(ln)
    if hit:
        a.tools.append("package install")
        a.flags.add("install")


def _fallback(lines: list[str], a: CiAnalysis) -> None:
    pat = re.compile(r"(?i)(^error\b|\berror:|\bfatal\b|exception|traceback|exit code [1-9]|command failed|process completed with exit code)")
    for ln in lines:
        if pat.search(ln) and ln.strip():
            a.add_error(ln)
        m = re.search(rf"({_PATH}):(\d+)", ln)
        if m:
            a.add_file(m.group(1))


def analyze_log(log: str) -> CiAnalysis:
    text = strip_noise(log)
    lines = text.split("\n")
    a = CiAnalysis()
    for fn in (_install, _tsc, _go, _maven, _jest_vitest, _pytest, _eslint, _ruff):
        fn(lines, a)
    flags = a.flags
    a.kind = next((k for k in ("install", "build", "test", "lint") if k in flags), "other")
    if a.kind == "other" or not a.error_lines:
        _fallback(lines, a)
    a.failing_tests = a.failing_tests[:MAX_LIST]
    a.error_lines = a.error_lines[:MAX_LIST]
    a.files = a.files[:10]
    return a


def build_summary(a: CiAnalysis, workflow: str | None = None, job: str | None = None) -> str:
    where = " / ".join(x for x in (workflow, job) if x)
    prefix = f"{where}: " if where else ""
    tools = ", ".join(dict.fromkeys(a.tools)) or "unknown tool"
    first = a.error_lines[0] if a.error_lines else ""
    if a.kind == "test":
        n = len(a.failing_tests)
        s = f"{prefix}{n} failing test(s) ({tools})" if n else f"{prefix}test run failed ({tools})"
        if a.failing_tests:
            s += ": " + ", ".join(a.failing_tests[:3]) + ("..." if n > 3 else "")
    elif a.kind == "lint":
        s = f"{prefix}lint check failed ({tools}), {len(a.error_lines)} issue(s) reported"
    elif a.kind == "build":
        s = f"{prefix}build/compile failed ({tools}), {len(a.error_lines)} error(s) reported"
    elif a.kind == "install":
        s = f"{prefix}dependency installation failed ({tools})"
    else:
        s = f"{prefix}job failed; no known tool output recognised"
    if first:
        s += f". First error: {first[:200]}"
    return s


def suggest_task(a: CiAnalysis, job: str | None = None) -> dict[str, str]:
    files = ", ".join(a.files[:5])
    errs = "\n".join(f"- {e}" for e in a.error_lines[:8])
    if a.kind == "test":
        title = "Fix failing tests: " + (", ".join(t.split("::")[-1] for t in a.failing_tests[:3]) or (job or "CI"))
        how = "Find why these tests fail, fix the code (or the test if it is wrong) and make the suite pass."
    elif a.kind == "lint":
        title = "Fix lint errors" + (f" in {a.files[0]}" if a.files else "")
        how = "Resolve the reported lint errors without disabling rules."
    elif a.kind == "build":
        title = "Fix build errors" + (f" in {a.files[0]}" if a.files else "")
        how = "Fix the compile/type errors so the build succeeds."
    elif a.kind == "install":
        title = "Fix dependency installation failure"
        how = "Resolve the dependency conflict or missing package so installation succeeds."
    else:
        title = f"Investigate CI failure{' in ' + job if job else ''}"
        how = "Work out why the job failed and fix it."
    failing = "\n".join(f"- {t}" for t in a.failing_tests[:10])
    desc = how + (f"\n\nFailing tests:\n{failing}" if failing else "") + (f"\n\nSuspected files: {files}" if files else "") + (f"\n\nErrors from the CI log:\n{errs}" if errs else "")
    return {"title": title[:120], "description": desc[:3000]}
