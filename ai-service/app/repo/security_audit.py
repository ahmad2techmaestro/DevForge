"""Security auditor: secrets, risky code patterns and dependency-manifest hygiene.

Everything here is static and deterministic. The LLM (when configured) only adds a written summary on top.
"""

from __future__ import annotations

import asyncio
import json
import math
import re
from collections import Counter
from dataclasses import dataclass, field

from app.repo.index import RepoIndex
from app.repo.rules import analyze_file
from app.repo.semgrep import SemgrepResult, run_semgrep
from app.repo.vulns import OsvResult, scan_dependencies
from app.schemas import Finding, Severity

# Findings from the general rule set that matter for security.
SECURITY_RULES = {
    "hardcoded-secret", "py-eval-exec", "py-subprocess-shell", "sql-string-format", "js-eval", "js-innerhtml",
}

_OTHER: list[tuple[re.Pattern[str], Severity, str, str, str, str]] = [
    (re.compile(r"(?i)verify\s*=\s*False"), "high", "tls-verify-disabled", "TLS verification disabled",
     "Certificate validation is turned off, allowing man-in-the-middle attacks.", "Remove verify=False."),
    (re.compile(r"(?i)\byaml\.load\((?![^)]*Loader\s*=\s*(yaml\.)?Safe)"), "high", "unsafe-yaml-load",
     "Unsafe yaml.load", "yaml.load can construct arbitrary objects.", "Use yaml.safe_load."),
    (re.compile(r"\bpickle\.loads?\("), "high", "unsafe-pickle", "Untrusted pickle deserialization",
     "Unpickling untrusted data executes arbitrary code.", "Use JSON or a safe format."),
    (re.compile(r"(?i)\b(md5|sha1)\s*\("), "low", "weak-hash", "Weak hash function",
     "MD5/SHA-1 are not collision resistant.", "Use SHA-256 or a password KDF for secrets."),
    (re.compile(r"(?i)Access-Control-Allow-Origin['\"]?\s*[:,]\s*['\"]\*"), "medium", "cors-wildcard",
     "Wildcard CORS", "Any website can read responses.", "Restrict to known origins."),
    (re.compile(r"(?i)(debug\s*=\s*True|app\.run\([^)]*debug\s*=\s*True)"), "medium", "debug-enabled",
     "Debug mode enabled", "Debug servers leak internals and may allow code execution.", "Disable in production."),
    (re.compile(r"(?i)\bchmod\s+(-R\s+)?0?777\b"), "medium", "chmod-777", "World-writable permissions",
     "chmod 777 lets any user modify the file.", "Use the least permissions needed."),
]  # fmt: skip

_ENV_FILES = (".env", ".env.local", ".env.production")

# Provider credential formats: (rule, label, severity, pattern). Matched values are never echoed.
_PROVIDER_KEYS: list[tuple[str, str, Severity, re.Pattern[str]]] = [
    ("secret-aws-access-key", "AWS access key id", "critical", re.compile(r"\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b")),
    ("secret-aws-secret-key", "AWS secret access key", "critical",
     re.compile(r"""(?i)aws_?secret_?(?:access_?)?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}\b""")),
    ("secret-github-token", "GitHub token", "critical", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b")),
    ("secret-github-token", "GitHub fine-grained token", "critical", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{40,}\b")),
    ("secret-google-api-key", "Google API key", "high", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("secret-google-oauth", "Google OAuth access token", "high", re.compile(r"\bya29\.[0-9A-Za-z_-]{20,}")),
    ("secret-slack-token", "Slack token", "critical", re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}")),
    ("secret-slack-webhook", "Slack webhook URL", "high",
     re.compile(r"https://hooks\.slack\.com/services/T[A-Za-z0-9]+/B[A-Za-z0-9]+/[A-Za-z0-9]{16,}")),
    ("secret-stripe-key", "Stripe live key", "critical", re.compile(r"\b[rs]k_live_[0-9A-Za-z]{16,}\b")),
    ("secret-anthropic-key", "Anthropic API key", "critical", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}")),
    ("secret-openai-key", "OpenAI API key", "critical", re.compile(r"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}")),
    ("secret-npm-token", "npm access token", "critical", re.compile(r"\bnpm_[A-Za-z0-9]{36}\b")),
    ("secret-sendgrid-key", "SendGrid API key", "critical", re.compile(r"\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}")),
    ("secret-private-key", "Private key", "critical", re.compile(r"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----")),
    ("secret-jwt", "JSON Web Token", "medium",
     re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")),
]  # fmt: skip
_SECRET_NAME = re.compile(r"(?i)(secret|passw(?:or)?d|passwd|api[_-]?key|access[_-]?key|auth[_-]?token|token|private[_-]?key|credential)")
_STR_ASSIGN = re.compile(r"""([A-Za-z_][\w.-]*)["']?\s*[:=]\s*["']([^"'\s]{20,})["']""")
_ENTROPY_SKIP_PATHS = re.compile(r"(?i)(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum)$|\.min\.(js|css)$|\.svg$")
_NOT_SECRET_VALUE = re.compile(
    r"(?i)^(https?://|sha\d+-|[a-f0-9-]{36}$|\$\{|<|\{\{|%\()|example|placeholder|changeme|your[_-]|xxxx|dummy|sample|process\.env|os\.environ|getenv"
)
ENTROPY_THRESHOLD = 4.0


def shannon_entropy(value: str) -> float:
    if not value:
        return 0.0
    n = len(value)
    return -sum(c / n * math.log2(c / n) for c in Counter(value).values())


def scan_secrets(path: str, text: str) -> list[Finding]:
    """Provider-key patterns plus entropy checks on secret-looking assignments. Values are never echoed."""
    if _ENTROPY_SKIP_PATHS.search(path):
        return []
    out: list[Finding] = []
    for i, line in enumerate(text.splitlines(), 1):
        if len(line) > 2000:  # minified / generated
            continue
        hit = False
        for rule, label, sev, pat in _PROVIDER_KEYS:
            m = pat.search(line)
            if m:
                hit = True
                out.append(_f(path, i, sev, rule, f"Possible {label} committed",
                              f"Line contains something shaped like a {label} ({len(m.group(0))} chars). Value not shown.",
                              "Revoke and rotate the credential, load it from the environment or a secret manager, "
                              "and purge it from git history."))  # fmt: skip
                break
        if hit:
            continue
        for m in _STR_ASSIGN.finditer(line):
            name, value = m.group(1), m.group(2)
            if not _SECRET_NAME.search(name) or _NOT_SECRET_VALUE.search(value) or "/" in value[:3]:
                continue
            if shannon_entropy(value) >= ENTROPY_THRESHOLD and len(set(value)) >= 10:
                out.append(_f(path, i, "high", "secret-high-entropy", "High-entropy value assigned to a secret-like name",
                              f"`{name}` is set to a random-looking string ({len(value)} chars, entropy "
                              f"{shannon_entropy(value):.1f} bits/char). Value not shown.",
                              "Move it to an environment variable / secret manager and rotate it."))  # fmt: skip
                break
    return out


@dataclass(slots=True)
class AuditReport:
    score: int
    grade: str
    counts: dict[str, int]
    findings: list[Finding]
    dependencies: dict[str, int]
    engines: dict[str, object] = field(default_factory=dict)
    tools: dict[str, str] = field(default_factory=dict)
    advisories: list[dict[str, object]] = field(default_factory=list)

    def to_json(self) -> dict[str, object]:
        out: dict[str, object] = {
            "score": self.score, "grade": self.grade, "counts": self.counts,
            "dependencies": self.dependencies,
            "findings": [f.model_dump(exclude_none=True) for f in self.findings],
        }  # fmt: skip
        if self.engines:
            out["engines"] = self.engines
            out["tools"] = self.tools
            out["advisories"] = self.advisories
        return out


def _f(path: str, line: int, sev: Severity, rule: str, title: str, detail: str, fix: str = "") -> Finding:
    return Finding(path=path, line=line, severity=sev, rule=rule, title=title, detail=detail, suggestion=fix or None)


def _check_package_json(path: str, text: str) -> tuple[list[Finding], int]:
    out: list[Finding] = []
    try:
        data = json.loads(text)
    except ValueError:
        return out, 0
    total = 0
    for section in ("dependencies", "devDependencies"):
        for name, spec in (data.get(section) or {}).items():
            total += 1
            if not isinstance(spec, str):
                continue
            if spec in ("*", "latest", "") or spec.startswith(("http:", "git:", "git+http:")):
                out.append(_f(path, 1, "medium", "dep-unpinned", f"Unpinned dependency: {name}",
                              f'"{name}": "{spec}" can change under you or pull unreviewed code.',
                              "Pin a semver range and commit a lockfile."))  # fmt: skip
    scripts = data.get("scripts") or {}
    for hook in ("preinstall", "postinstall", "install"):
        if hook in scripts:
            out.append(_f(path, 1, "low", "install-script", f"Lifecycle script: {hook}",
                          "Install scripts run automatically on every install.", "Review what it executes."))  # fmt: skip
    return out, total


def _check_requirements(path: str, text: str) -> tuple[list[Finding], int]:
    out: list[Finding] = []
    total = 0
    for i, raw in enumerate(text.splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line or line.startswith(("-", "git+", "http")):
            if line.startswith(("git+http:", "http:")):
                out.append(_f(path, i, "medium", "dep-insecure-source", "Dependency over plain HTTP",
                              "Fetched without transport security.", "Use https."))  # fmt: skip
            continue
        total += 1
        if "==" not in line:
            name = re.split(r"[<>=~!\[; ]", line, maxsplit=1)[0]
            out.append(_f(path, i, "low", "dep-unpinned", f"Unpinned dependency: {name}",
                          "Without an exact pin builds are not reproducible.",
                          "Pin with == (or use a lock file)."))  # fmt: skip
    return out, total


def _check_dockerfile(path: str, text: str) -> list[Finding]:
    out: list[Finding] = []
    lines = text.splitlines()
    if not any(re.match(r"\s*USER\s+(?!root\b)\S+", ln, re.I) for ln in lines):
        out.append(_f(path, 1, "medium", "docker-root-user", "Container runs as root",
                      "No non-root USER instruction found.", "Add a USER instruction."))  # fmt: skip
    stages = {m.group(1).lower() for ln in lines if (m := re.search(r"\bAS\s+(\S+)\s*$", ln, re.I))}
    for i, ln in enumerate(lines, 1):
        m = re.match(r"\s*FROM\s+(?:--\S+\s+)?(\S+)", ln, re.I)
        if not m:
            continue
        image = m.group(1)
        pinned = "@sha256:" in image or (":" in image and not image.endswith(":latest"))
        if not pinned and image.lower() != "scratch" and image.lower() not in stages:
            out.append(_f(path, i, "low", "docker-latest-tag", "Unpinned base image",
                          "The :latest (or untagged) image changes without notice.", "Pin a version tag."))  # fmt: skip
    return out


def audit(index: RepoIndex, extra: list[Finding] | None = None) -> AuditReport:
    findings: list[Finding] = list(extra or [])
    deps: Counter[str] = Counter()
    for info in index.files:
        text = index.texts.get(info.path)
        if text is None:
            continue
        name = info.path.rsplit("/", 1)[-1]
        base = [f for f in analyze_file(info.path, info.language, text) if f.rule in SECURITY_RULES]
        covered = {f.line for f in base if f.rule == "hardcoded-secret"}  # already flagged by the shared scanner
        findings += base
        findings += [f for f in scan_secrets(info.path, text) if f.line not in covered]
        for i, line in enumerate(text.splitlines(), 1):
            for pat, sev, rule, title, detail, fix in _OTHER:
                if pat.search(line) and "test" not in info.path.lower().split("/")[-1]:
                    findings.append(_f(info.path, i, sev, rule, title, detail, fix))
        if name in _ENV_FILES:
            findings.append(_f(info.path, 1, "high", "committed-env-file", "Environment file committed",
                               "Env files usually contain secrets and should not be in version control.",
                               "Remove it from git history and add it to .gitignore."))  # fmt: skip
        if name == "package.json":
            f, n = _check_package_json(info.path, text)
            findings += f
            deps["npm"] += n
        elif name.startswith("requirements") and name.endswith(".txt"):
            f, n = _check_requirements(info.path, text)
            findings += f
            deps["pip"] += n
        elif name == "Dockerfile":
            findings += _check_dockerfile(info.path, text)
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
    seen: set[tuple[str, int, str]] = set()
    unique: list[Finding] = []
    for f in sorted(findings, key=lambda x: (order[x.severity], x.path, x.line)):
        key = (f.path, f.line, f.rule)
        if key not in seen:
            seen.add(key)
            unique.append(f)
    counts = Counter(f.severity for f in unique)
    penalty = counts["critical"] * 25 + counts["high"] * 12 + counts["medium"] * 4 + counts["low"]
    score = max(0, 100 - penalty)
    grade = "A" if score >= 90 else "B" if score >= 75 else "C" if score >= 60 else "D" if score >= 40 else "F"
    return AuditReport(score, grade, dict(counts), unique[:300], dict(deps))


async def audit_with_engines(index: RepoIndex, osv_url: str) -> AuditReport:
    """Static audit plus OSV dependency scan and (if installed) Semgrep. Engine trouble never fails the audit."""
    manifests = [(i.path, index.texts[i.path]) for i in index.files if i.path in index.texts]
    osv, sg = await asyncio.gather(
        scan_dependencies(manifests, osv_url), run_semgrep(index.root), return_exceptions=True
    )
    if isinstance(osv, BaseException):
        osv = OsvResult("unreachable", error=type(osv).__name__)
    if isinstance(sg, BaseException):
        sg = SemgrepResult("failed", error=type(sg).__name__)
    report = audit(index, osv.findings + sg.findings)
    report.engines = {"static": {"status": "ok"}, "osv": osv.engine_info(), "semgrep": sg.engine_info()}
    report.tools = {"semgrep": "ok" if sg.status == "ok" else sg.status if sg.status == "missing" else "failed", "osv": osv.status}
    report.advisories = osv.advisories[:200]
    return report
