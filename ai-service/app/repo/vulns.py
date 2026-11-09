"""Dependency vulnerability scanning against OSV.dev.

Manifests are parsed locally into (ecosystem, name, version) triples. Only those triples are ever sent to
OSV (never file contents). When OSV cannot be reached the scan degrades to ``status: "unreachable"`` instead
of failing the audit.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import math
import re
import tomllib
from collections.abc import Iterable
from dataclasses import dataclass, field

import httpx

from app.schemas import Finding, Severity

MAX_PACKAGES = 5000
BATCH_SIZE = 500
MAX_PAGES = 5
MAX_DETAIL_FETCH = 200
DETAIL_CONCURRENCY = 8
TIMEOUT = httpx.Timeout(15.0, connect=4.0)
RETRIES = 2  # total attempts = RETRIES + 1
BACKOFF = 0.25

_SEMVER = re.compile(r"^v?\d+(\.\d+){0,3}([-+.][0-9A-Za-z.+-]+)?$")


@dataclass(frozen=True, slots=True)
class Dependency:
    ecosystem: str  # OSV ecosystem name: PyPI, npm, Go, RubyGems, Maven
    name: str
    version: str
    path: str
    line: int = 1

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.ecosystem, self.name, self.version)


@dataclass(slots=True)
class OsvResult:
    status: str  # ok | partial | unreachable | skipped
    packages: int = 0
    vulnerable: int = 0
    findings: list[Finding] = field(default_factory=list)
    advisories: list[dict[str, object]] = field(default_factory=list)
    error: str | None = None

    def engine_info(self) -> dict[str, object]:
        out: dict[str, object] = {
            "status": self.status, "packages": self.packages, "vulnerablePackages": self.vulnerable,
            "advisories": len(self.advisories),
        }
        if self.error:
            out["error"] = self.error
        return out


# ---- manifest parsing -----------------------------------------------------------------------------


def _norm_py(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_requirements(path: str, text: str) -> list[Dependency]:
    out: list[Dependency] = []
    for i, raw in enumerate(text.splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line or line.startswith(("-", "git+", "http")):
            continue
        line = line.split(";", 1)[0].strip()  # environment markers
        m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*===?\s*([A-Za-z0-9][A-Za-z0-9.+!_-]*)", line)
        if m:
            out.append(Dependency("PyPI", _norm_py(m.group(1)), m.group(2), path, i))
    return out


def _pin_from_spec(spec: str) -> str | None:
    m = re.match(r"^\s*(?:\[[^\]]*\])?\s*===?\s*([A-Za-z0-9][A-Za-z0-9.+!_-]*)\s*$", spec)
    return m.group(1) if m else None


def _line_of(text: str, needle: str) -> int:
    idx = text.find(needle)
    return text.count("\n", 0, idx) + 1 if idx >= 0 else 1


def parse_pyproject(path: str, text: str) -> list[Dependency]:
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        return []
    out: list[Dependency] = []

    def pep508(entry: object) -> None:
        if not isinstance(entry, str):
            return
        m = re.match(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(===?\s*[^\s;,]+)?", entry)
        if m and m.group(3):
            pin = _pin_from_spec(m.group(3))
            if pin and "," not in entry.split(";")[0]:
                out.append(Dependency("PyPI", _norm_py(m.group(1)), pin, path, _line_of(text, entry)))

    project = data.get("project") or {}
    for entry in project.get("dependencies") or []:
        pep508(entry)
    for group in (project.get("optional-dependencies") or {}).values():
        for entry in group or []:
            pep508(entry)
    for group in (data.get("dependency-groups") or {}).values():
        for entry in group or []:
            pep508(entry)
    poetry = (data.get("tool") or {}).get("poetry") or {}
    tables = [poetry.get("dependencies") or {}, poetry.get("dev-dependencies") or {}]
    for g in (poetry.get("group") or {}).values():
        tables.append((g or {}).get("dependencies") or {})
    for table in tables:
        for name, spec in table.items():
            ver = spec.get("version") if isinstance(spec, dict) else spec
            if name.lower() != "python" and isinstance(ver, str) and re.fullmatch(r"=?=?\s*\d+(\.\d+)*[A-Za-z0-9.+-]*", ver):
                out.append(Dependency("PyPI", _norm_py(name), ver.lstrip("= "), path, _line_of(text, name)))
    return out


def _exact_semver(spec: str) -> str | None:
    spec = spec.strip()
    return spec.lstrip("=").strip().lstrip("v") if re.fullmatch(r"=?v?\d+\.\d+\.\d+([-+][0-9A-Za-z.+-]+)?", spec) else None


def parse_package_json(path: str, text: str) -> list[Dependency]:
    try:
        data = json.loads(text)
    except ValueError:
        return []
    if not isinstance(data, dict):
        return []
    out: list[Dependency] = []
    for section in ("dependencies", "devDependencies", "optionalDependencies"):
        for name, spec in (data.get(section) or {}).items():
            if isinstance(spec, str) and (v := _exact_semver(spec)):
                out.append(Dependency("npm", name, v, path, _line_of(text, f'"{name}"')))
    return out


def parse_package_lock(path: str, text: str) -> list[Dependency]:
    try:
        data = json.loads(text)
    except ValueError:
        return []
    if not isinstance(data, dict):
        return []
    out: list[Dependency] = []
    packages = data.get("packages")
    if isinstance(packages, dict):  # lockfile v2/v3
        for key, meta in packages.items():
            if not key or not isinstance(meta, dict) or meta.get("link"):
                continue
            name = meta.get("name") or key.rsplit("node_modules/", 1)[-1]
            ver = meta.get("version")
            if isinstance(ver, str) and "node_modules/" in key:
                out.append(Dependency("npm", name, ver, path, 1))
        return out

    def walk(deps: object) -> None:  # lockfile v1
        if not isinstance(deps, dict):
            return
        for name, meta in deps.items():
            if isinstance(meta, dict):
                ver = meta.get("version")
                if isinstance(ver, str) and _SEMVER.match(ver):
                    out.append(Dependency("npm", name, ver, path, 1))
                walk(meta.get("dependencies"))

    walk(data.get("dependencies"))
    return out


def parse_go_mod(path: str, text: str) -> list[Dependency]:
    out: list[Dependency] = []
    in_block = False
    for i, raw in enumerate(text.splitlines(), 1):
        line = raw.split("//", 1)[0].strip()
        if not line:
            continue
        if line.startswith("require ("):
            in_block = True
            continue
        if in_block and line == ")":
            in_block = False
            continue
        body = line[len("require "):].strip() if line.startswith("require ") else (line if in_block else "")
        parts = body.split()
        if len(parts) >= 2 and re.match(r"^v\d", parts[1]):
            out.append(Dependency("Go", parts[0], parts[1].lstrip("v"), path, i))
    return out


def parse_gemfile_lock(path: str, text: str) -> list[Dependency]:
    out: list[Dependency] = []
    in_specs = False
    for i, raw in enumerate(text.splitlines(), 1):
        if raw.strip() == "specs:":
            in_specs = True
            continue
        if in_specs:
            m = re.match(r"^ {4}([A-Za-z0-9._-]+) \(([^)\s]+)\)\s*$", raw)
            if m:
                out.append(Dependency("RubyGems", m.group(1), m.group(2), path, i))
            elif raw and not raw.startswith("    "):
                in_specs = False
    return out


def parse_pom(path: str, text: str) -> list[Dependency]:
    """Regex based (no XML entity expansion): only dependencies with a literal version."""
    out: list[Dependency] = []
    text_nc = re.sub(r"<!--.*?-->", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S)
    for m in re.finditer(r"<dependency>(.*?)</dependency>", text_nc, re.S):
        block = m.group(1)

        def tag(name: str, _b: str = block) -> str | None:
            t = re.search(rf"<{name}>\s*([^<]+?)\s*</{name}>", _b)
            return t.group(1) if t else None

        g, a, v = tag("groupId"), tag("artifactId"), tag("version")
        if g and a and v and "${" not in f"{g}{a}{v}" and not v.startswith(("[", "(")):
            out.append(Dependency("Maven", f"{g}:{a}", v, path, text_nc.count("\n", 0, m.start()) + 1))
    return out


def parse_manifests(files: Iterable[tuple[str, str]]) -> list[Dependency]:
    """Parse every supported manifest among (path, text) pairs. Unique per (ecosystem, name, version)."""
    deps: list[Dependency] = []
    for path, text in files:
        name = path.replace("\\", "/").rsplit("/", 1)[-1]
        if name.startswith("requirements") and name.endswith(".txt"):
            deps += parse_requirements(path, text)
        elif name == "pyproject.toml":
            deps += parse_pyproject(path, text)
        elif name == "package.json":
            deps += parse_package_json(path, text)
        elif name == "package-lock.json":
            deps += parse_package_lock(path, text)
        elif name == "go.mod":
            deps += parse_go_mod(path, text)
        elif name == "Gemfile.lock":
            deps += parse_gemfile_lock(path, text)
        elif name == "pom.xml":
            deps += parse_pom(path, text)
    seen: set[tuple[str, str, str]] = set()
    unique: list[Dependency] = []
    for d in deps:
        if d.key not in seen:
            seen.add(d.key)
            unique.append(d)
    return unique


# ---- severity ---------------------------------------------------------------------------------------

_W = {
    "AV": {"N": 0.85, "A": 0.62, "L": 0.55, "P": 0.2}, "AC": {"L": 0.77, "H": 0.44},
    "UI": {"N": 0.85, "R": 0.62}, "CIA": {"H": 0.56, "L": 0.22, "N": 0.0},
}  # fmt: skip


def _roundup(x: float) -> float:
    i = round(x * 100000)
    return i / 100000.0 if i % 10000 == 0 else (math.floor(i / 10000) + 1) / 10.0


def cvss3_score(vector: str) -> float | None:
    """Base score of a CVSS v3.x vector string, or None when it is not a parsable v3 vector."""
    if not vector.startswith("CVSS:3"):
        return None
    m = dict(p.split(":", 1) for p in vector.split("/")[1:] if ":" in p)
    try:
        scope_changed = m["S"] == "C"
        pr = {"N": 0.85, "L": 0.68 if scope_changed else 0.62, "H": 0.5 if scope_changed else 0.27}[m["PR"]]
        expl = 8.22 * _W["AV"][m["AV"]] * _W["AC"][m["AC"]] * pr * _W["UI"][m["UI"]]
        iss = 1 - (1 - _W["CIA"][m["C"]]) * (1 - _W["CIA"][m["I"]]) * (1 - _W["CIA"][m["A"]])
    except KeyError:
        return None
    impact = 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 if scope_changed else 6.42 * iss
    if impact <= 0:
        return 0.0
    return _roundup(min((1.08 if scope_changed else 1.0) * (impact + expl), 10))


def _sev_from_score(score: float) -> Severity:
    return "critical" if score >= 9 else "high" if score >= 7 else "medium" if score >= 4 else "low" if score > 0 else "info"


_DB_SEV: dict[str, Severity] = {
    "CRITICAL": "critical", "HIGH": "high", "MODERATE": "medium", "MEDIUM": "medium", "LOW": "low",
}


def vuln_severity(vuln: dict[str, object]) -> tuple[Severity, float | None]:
    """Severity from the advisory's curated rating, else from a CVSS v3 vector, else medium."""
    score: float | None = None
    for s in vuln.get("severity") or []:  # type: ignore[attr-defined]
        if isinstance(s, dict) and isinstance(s.get("score"), str):
            raw = s["score"]
            score = cvss3_score(raw) if raw.startswith("CVSS:3") else (float(raw) if re.fullmatch(r"\d+(\.\d+)?", raw) else None)
            if score is not None:
                break
    db = vuln.get("database_specific")
    if isinstance(db, dict) and isinstance(db.get("severity"), str) and db["severity"].upper() in _DB_SEV:
        return _DB_SEV[db["severity"].upper()], score
    if score is not None:
        return _sev_from_score(score), score
    return "medium", None


def fixed_versions(vuln: dict[str, object], dep: Dependency) -> list[str]:
    out: list[str] = []
    for aff in vuln.get("affected") or []:  # type: ignore[attr-defined]
        if not isinstance(aff, dict):
            continue
        pkg = aff.get("package") or {}
        if pkg.get("ecosystem") and pkg.get("ecosystem") != dep.ecosystem:
            continue
        if pkg.get("name") and _norm_py(str(pkg["name"])) != _norm_py(dep.name) and dep.ecosystem == "PyPI":
            continue
        if pkg.get("name") and dep.ecosystem != "PyPI" and pkg["name"] != dep.name:
            continue
        for rng in aff.get("ranges") or []:
            for ev in (rng or {}).get("events") or []:
                if isinstance(ev, dict) and isinstance(ev.get("fixed"), str) and ev["fixed"] not in out:
                    out.append(ev["fixed"])
    return out[:6]


def advisory_url(vuln: dict[str, object]) -> str:
    refs = [r for r in vuln.get("references") or [] if isinstance(r, dict) and isinstance(r.get("url"), str)]  # type: ignore[attr-defined]
    for want in ("ADVISORY", "WEB"):
        for r in refs:
            if r.get("type") == want:
                return str(r["url"])
    return f"https://osv.dev/vulnerability/{vuln.get('id')}"


# ---- OSV client ------------------------------------------------------------------------------------


class OsvUnreachable(Exception):
    pass


async def _request(client: httpx.AsyncClient, method: str, url: str, **kw: object) -> dict[str, object]:
    last: Exception | None = None
    for attempt in range(RETRIES + 1):
        try:
            r = await client.request(method, url, **kw)  # type: ignore[arg-type]
        except httpx.HTTPError as exc:  # connect/read timeouts, DNS failure, TLS, proxy errors
            last = exc
        else:
            if r.status_code == 200:
                try:
                    data = r.json()
                except ValueError as exc:
                    raise OsvUnreachable("invalid JSON from OSV") from exc
                return data if isinstance(data, dict) else {}
            last = OsvUnreachable(f"HTTP {r.status_code}")
            if r.status_code < 500 and r.status_code != 429:
                break  # a client error will not fix itself
        if attempt < RETRIES:
            await asyncio.sleep(BACKOFF * (2**attempt))
    raise OsvUnreachable(type(last).__name__ if not isinstance(last, OsvUnreachable) else str(last))


async def _query_batch(client: httpx.AsyncClient, base: str, deps: list[Dependency]) -> list[list[str]]:
    """Vulnerability ids per dependency (parallel to `deps`), following pagination."""
    ids: list[list[str]] = [[] for _ in deps]
    pending = [(i, None) for i in range(len(deps))]  # (dep index, page token)
    for _ in range(MAX_PAGES):
        if not pending:
            break
        nxt: list[tuple[int, str | None]] = []
        for start in range(0, len(pending), BATCH_SIZE):
            chunk = pending[start : start + BATCH_SIZE]
            queries = []
            for i, token in chunk:
                q: dict[str, object] = {
                    "package": {"name": deps[i].name, "ecosystem": deps[i].ecosystem}, "version": deps[i].version,
                }  # fmt: skip
                if token:
                    q["page_token"] = token
                queries.append(q)
            data = await _request(client, "POST", f"{base}/v1/querybatch", json={"queries": queries})
            results = data.get("results")
            if not isinstance(results, list):
                raise OsvUnreachable("unexpected OSV response")
            for (i, _), res in zip(chunk, results, strict=False):
                if not isinstance(res, dict):
                    continue
                ids[i] += [str(v["id"]) for v in res.get("vulns") or [] if isinstance(v, dict) and "id" in v]
                if res.get("next_page_token"):
                    nxt.append((i, str(res["next_page_token"])))
        pending = nxt
    return ids


async def _details(client: httpx.AsyncClient, base: str, vuln_ids: list[str]) -> dict[str, dict[str, object]]:
    sem = asyncio.Semaphore(DETAIL_CONCURRENCY)
    out: dict[str, dict[str, object]] = {}

    async def one(vid: str) -> None:
        async with sem:
            with contextlib.suppress(OsvUnreachable):  # keep the finding, with default severity
                out[vid] = await _request(client, "GET", f"{base}/v1/vulns/{vid}")

    await asyncio.gather(*(one(v) for v in vuln_ids[:MAX_DETAIL_FETCH]))
    return out


def _to_finding(dep: Dependency, vid: str, vuln: dict[str, object] | None) -> tuple[Finding, dict[str, object]]:
    vuln = vuln or {"id": vid}
    sev, score = vuln_severity(vuln)
    fixed = fixed_versions(vuln, dep) if vuln.get("affected") else []
    url = advisory_url(vuln)
    aliases = [str(a) for a in vuln.get("aliases") or []][:5]  # type: ignore[attr-defined]
    summary = str(vuln.get("summary") or "Known vulnerability").strip()[:200]
    detail = f"{dep.name}@{dep.version} ({dep.ecosystem}) is affected by {vid}: {summary}. Advisory: {url}"
    if fixed:
        detail += f" Fixed in: {', '.join(fixed)}."
    fix = f"Upgrade {dep.name} to {fixed[0]} or later." if fixed else f"Check {url} for remediation."
    finding = Finding(
        path=dep.path, line=dep.line, severity=sev, rule=f"vuln-{vid}", title=f"{vid}: {dep.name} {dep.version}",
        detail=detail, suggestion=fix,
    )  # fmt: skip
    info: dict[str, object] = {
        "id": vid, "aliases": aliases, "package": dep.name, "ecosystem": dep.ecosystem, "version": dep.version,
        "severity": sev, "cvss": score, "fixedIn": fixed, "url": url, "path": dep.path,
    }  # fmt: skip
    return finding, info


def make_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": "devforge-security-audit"})


async def scan_dependencies(
    files: Iterable[tuple[str, str]],
    osv_url: str,
    *,
    client: httpx.AsyncClient | None = None,
) -> OsvResult:
    """Scan every supported manifest among (path, text) pairs. Never raises on network trouble."""
    base = (osv_url or "").rstrip("/")
    deps = parse_manifests(files)[:MAX_PACKAGES]
    if not base or base.lower() in ("off", "none", "disabled"):
        return OsvResult("skipped", len(deps), error="OSV disabled")
    if not deps:
        return OsvResult("ok", 0)
    own = client is None
    http = client or make_client()
    try:
        ids = await _query_batch(http, base, deps)
        wanted = list(dict.fromkeys(v for per in ids for v in per))
        details = await _details(http, base, wanted) if wanted else {}
    except OsvUnreachable as exc:
        return OsvResult("unreachable", len(deps), error=str(exc))
    except Exception as exc:  # defensive: the audit must never fail because of OSV
        return OsvResult("unreachable", len(deps), error=type(exc).__name__)
    finally:
        if own:
            await http.aclose()
    res = OsvResult("ok", len(deps))
    for dep, per in zip(deps, ids, strict=True):
        uniq = list(dict.fromkeys(per))
        if uniq:
            res.vulnerable += 1
        for vid in uniq:
            finding, info = _to_finding(dep, vid, details.get(vid))
            res.findings.append(finding)
            res.advisories.append(info)
    if any(v not in details for v in wanted):
        res.status = "partial"
        res.error = "some advisory details could not be fetched; severity defaults to medium"
    return res
