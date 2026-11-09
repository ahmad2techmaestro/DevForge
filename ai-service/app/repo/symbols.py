"""Symbol, import and call extraction.

Uses tree-sitter when the optional ``intel`` extra is installed (Python, JavaScript, TypeScript/TSX,
Go, Java); otherwise falls back to the stdlib ``ast`` (Python) and regexes (everything else).
A missing or broken tree-sitter install never raises: callers just see ``engine == "fallback"``.
"""

from __future__ import annotations

import ast
import importlib
import re
from dataclasses import dataclass, field
from functools import cache
from typing import Any

SUPPORTED = ("Python", "JavaScript", "TypeScript", "Go", "Java")
FUNC_KINDS = frozenset({"function", "method", "constructor"})
MAX_PARSE_BYTES = 600_000

_GRAMMARS: dict[str, tuple[str, str]] = {
    "Python": ("tree_sitter_python", "language"),
    "JavaScript": ("tree_sitter_javascript", "language"),
    "TypeScript": ("tree_sitter_typescript", "language_typescript"),
    "TSX": ("tree_sitter_typescript", "language_tsx"),
    "Go": ("tree_sitter_go", "language"),
    "Java": ("tree_sitter_java", "language"),
}


@dataclass(slots=True)
class Symbol:
    name: str
    kind: str  # function | method | constructor | class | interface | struct | enum | type
    path: str
    line: int
    end_line: int
    parent: str | None = None
    complexity: int = 1

    @property
    def qname(self) -> str:
        return f"{self.parent}.{self.name}" if self.parent else self.name

    def to_json(self) -> dict[str, object]:
        out: dict[str, object] = {
            "name": self.qname, "kind": self.kind, "path": self.path,
            "line": self.line, "endLine": self.end_line,
        }  # fmt: skip
        if self.kind in FUNC_KINDS:
            out["complexity"] = self.complexity
        return out


@dataclass(slots=True)
class ImportRef:
    module: str  # raw module / path string as written
    names: list[str] = field(default_factory=list)
    line: int = 1
    level: int = 0  # python relative import dots


@dataclass(slots=True)
class CallRef:
    name: str
    line: int
    qualifier: str | None = None
    caller: str | None = None  # qname of enclosing function/method, None = module level


@dataclass(slots=True)
class FileSymbols:
    path: str
    language: str
    engine: str
    symbols: list[Symbol] = field(default_factory=list)
    imports: list[ImportRef] = field(default_factory=list)
    calls: list[CallRef] = field(default_factory=list)


# ---------------------------------------------------------------- tree-sitter loading


@cache
def _parser(lang_key: str) -> Any | None:
    try:
        ts = importlib.import_module("tree_sitter")
        mod_name, fn = _GRAMMARS[lang_key]
        lang = ts.Language(getattr(importlib.import_module(mod_name), fn)())
        return ts.Parser(lang)
    except Exception:  # ImportError, missing wheel, ABI mismatch ...
        return None


def reset_engine_cache() -> None:
    """Forget which grammars loaded (tests / hot reload)."""
    _parser.cache_clear()


def treesitter_available() -> bool:
    return _parser("Python") is not None


def _lang_key(path: str, language: str) -> str:
    return "TSX" if path.endswith((".tsx", ".jsx")) and language == "TypeScript" else language


# ---------------------------------------------------------------- tree-sitter extraction

_BRANCH = frozenset({
    "if_statement", "elif_clause", "for_statement", "while_statement", "for_in_statement",
    "except_clause", "case_clause", "conditional_expression", "boolean_operator",
    "catch_clause", "switch_case", "ternary_expression", "do_statement", "expression_case",
    "type_case", "communication_case", "for_expression", "enhanced_for_statement",
    "switch_label", "binary_expression_logical",
})  # fmt: skip
_LOGICAL_OPS = frozenset({"&&", "||", "??"})


def _txt(node: Any) -> str:
    return node.text.decode("utf-8", "replace") if node is not None else ""


def _last_ident(node: Any) -> str:
    return _txt(node).split(".")[-1].split("::")[-1]


class _Walker:
    def __init__(self, path: str, language: str, src: bytes) -> None:
        self.fs = FileSymbols(path, language, "tree-sitter")
        self.lang = language
        self.src = src
        self.stack: list[Symbol] = []

    def run(self, root: Any) -> FileSymbols:
        self.visit(root, 0)
        return self.fs

    # -- helpers
    def _add(self, name: str, kind: str, node: Any) -> Symbol:
        parent = next((s.qname for s in reversed(self.stack) if s.kind not in FUNC_KINDS), None)
        sym = Symbol(name, kind, self.fs.path, node.start_point[0] + 1, node.end_point[0] + 1, parent)
        self.fs.symbols.append(sym)
        return sym

    def _enclosing_func(self) -> Symbol | None:
        return next((s for s in reversed(self.stack) if s.kind in FUNC_KINDS), None)

    def _call(self, name: str, qualifier: str | None, node: Any) -> None:
        if not name:
            return
        fn = self._enclosing_func()
        self.fs.calls.append(
            CallRef(name, node.start_point[0] + 1, qualifier, fn.qname if fn else None)
        )

    def _complexity_bump(self, node: Any) -> None:
        fn = self._enclosing_func()
        if fn is None:
            return
        t = node.type
        if t in _BRANCH:
            fn.complexity += 1
        elif t in ("binary_expression", "binary_operator"):
            op = node.child_by_field_name("operator")
            if op is not None and _txt(op) in _LOGICAL_OPS:
                fn.complexity += 1

    # -- main traversal
    def visit(self, node: Any, depth: int) -> None:
        if depth > 400:
            return
        t = node.type
        pushed = False
        handler = getattr(self, "_" + self.lang.lower() + "_" + "node", None)
        if handler is not None:
            pushed = bool(handler(node, t))
        else:  # pragma: no cover
            pass
        self._complexity_bump(node)
        for child in node.children:
            self.visit(child, depth + 1)
        if pushed:
            self.stack.pop()

    # Python ------------------------------------------------------------
    def _python_node(self, node: Any, t: str) -> bool:
        if t == "function_definition":
            name = _txt(node.child_by_field_name("name"))
            in_class = bool(self.stack) and self.stack[-1].kind == "class"
            self.stack.append(self._add(name, "method" if in_class else "function", node))
            return True
        if t == "class_definition":
            self.stack.append(self._add(_txt(node.child_by_field_name("name")), "class", node))
            return True
        if t == "import_statement":
            for c in node.named_children:
                target = c.child_by_field_name("name") if c.type == "aliased_import" else c
                if target is not None and target.type == "dotted_name":
                    self.fs.imports.append(ImportRef(_txt(target), [], node.start_point[0] + 1))
        elif t == "import_from_statement":
            mod = node.child_by_field_name("module_name")
            raw = _txt(mod)
            level = len(raw) - len(raw.lstrip("."))
            names: list[str] = []
            for c in node.children_by_field_name("name"):
                names.append(_txt(c.child_by_field_name("name") if c.type == "aliased_import" else c))
            if any(c.type == "wildcard_import" for c in node.children):
                names.append("*")
            self.fs.imports.append(ImportRef(raw.lstrip("."), names, node.start_point[0] + 1, level))
        elif t == "call":
            fn = node.child_by_field_name("function")
            if fn is not None and fn.type == "identifier":
                self._call(_txt(fn), None, node)
            elif fn is not None and fn.type == "attribute":
                self._call(_txt(fn.child_by_field_name("attribute")), _txt(fn.child_by_field_name("object")), node)
        return False

    # JavaScript / TypeScript -------------------------------------------
    def _js_node(self, node: Any, t: str) -> bool:
        if t in ("function_declaration", "generator_function_declaration"):
            self.stack.append(self._add(_txt(node.child_by_field_name("name")), "function", node))
            return True
        if t in ("class_declaration", "abstract_class_declaration"):
            self.stack.append(self._add(_txt(node.child_by_field_name("name")), "class", node))
            return True
        if t in ("interface_declaration", "enum_declaration", "type_alias_declaration"):
            kind = {"interface_declaration": "interface", "enum_declaration": "enum"}.get(t, "type")
            self._add(_txt(node.child_by_field_name("name")), kind, node)
            return False
        if t == "method_definition":
            name = _txt(node.child_by_field_name("name"))
            kind = "constructor" if name == "constructor" else "method"
            self.stack.append(self._add(name, kind, node))
            return True
        if t == "variable_declarator":
            val = node.child_by_field_name("value")
            name_node = node.child_by_field_name("name")
            if val is not None and name_node is not None and name_node.type == "identifier" and val.type in (
                "arrow_function", "function_expression", "function", "generator_function",
            ):  # fmt: skip
                self.stack.append(self._add(_txt(name_node), "function", node))
                return True
        elif t == "import_statement" or (t == "export_statement" and node.child_by_field_name("source")):
            src = node.child_by_field_name("source")
            if src is not None:
                names = [_txt(c) for c in _descend(node, ("identifier",), stop=("string",))]
                self.fs.imports.append(ImportRef(_txt(src).strip("'\"`"), names, node.start_point[0] + 1))
        elif t == "call_expression":
            fn = node.child_by_field_name("function")
            if fn is None:
                return False
            if fn.type == "identifier":
                if _txt(fn) == "require":
                    args = node.child_by_field_name("arguments")
                    first = args.named_children[0] if args is not None and args.named_children else None
                    if first is not None and first.type == "string":
                        decl = node.parent
                        names = []
                        if decl is not None and decl.type == "variable_declarator":
                            names = [_txt(c) for c in _descend(decl.child_by_field_name("name"), ("identifier", "shorthand_property_identifier_pattern"))]
                        self.fs.imports.append(ImportRef(_txt(first).strip("'\"`"), names, node.start_point[0] + 1))
                else:
                    self._call(_txt(fn), None, node)
            elif fn.type == "member_expression":
                self._call(_txt(fn.child_by_field_name("property")), _txt(fn.child_by_field_name("object")), node)
        elif t == "new_expression":
            ctor = node.child_by_field_name("constructor")
            if ctor is not None:
                self._call(_last_ident(ctor), None, node)
        return False

    _javascript_node = _js_node
    _typescript_node = _js_node

    # Go -----------------------------------------------------------------
    def _go_node(self, node: Any, t: str) -> bool:
        if t == "function_declaration":
            self.stack.append(self._add(_txt(node.child_by_field_name("name")), "function", node))
            return True
        if t == "method_declaration":
            sym = self._add(_txt(node.child_by_field_name("name")), "method", node)
            recv = node.child_by_field_name("receiver")
            m = re.search(r"\*?\s*([A-Za-z_]\w*)\s*\)?$", _txt(recv).strip()) if recv is not None else None
            sym.parent = m.group(1) if m else None
            self.stack.append(sym)
            return True
        if t == "type_spec":
            body = node.child_by_field_name("type")
            kind = {"struct_type": "struct", "interface_type": "interface"}.get(body.type if body is not None else "", "type")
            self._add(_txt(node.child_by_field_name("name")), kind, node)
        elif t == "import_spec":
            p = node.child_by_field_name("path")
            alias = node.child_by_field_name("name")
            self.fs.imports.append(
                ImportRef(_txt(p).strip("\"`"), [_txt(alias)] if alias is not None else [], node.start_point[0] + 1)
            )
        elif t == "call_expression":
            fn = node.child_by_field_name("function")
            if fn is not None and fn.type == "identifier":
                self._call(_txt(fn), None, node)
            elif fn is not None and fn.type == "selector_expression":
                self._call(_txt(fn.child_by_field_name("field")), _txt(fn.child_by_field_name("operand")), node)
        return False

    # Java ---------------------------------------------------------------
    def _java_node(self, node: Any, t: str) -> bool:
        if t in ("class_declaration", "interface_declaration", "enum_declaration", "record_declaration"):
            kind = {"class_declaration": "class", "interface_declaration": "interface"}.get(t, "enum")
            self.stack.append(self._add(_txt(node.child_by_field_name("name")), kind, node))
            return True
        if t in ("method_declaration", "constructor_declaration"):
            kind = "method" if t == "method_declaration" else "constructor"
            self.stack.append(self._add(_txt(node.child_by_field_name("name")), kind, node))
            return True
        if t == "import_declaration":
            raw = _txt(node).removeprefix("import").removesuffix(";").replace("static", "", 1).strip()
            self.fs.imports.append(ImportRef(raw, [], node.start_point[0] + 1))
        elif t == "method_invocation":
            obj = node.child_by_field_name("object")
            self._call(_txt(node.child_by_field_name("name")), _txt(obj) if obj is not None else None, node)
        elif t == "object_creation_expression":
            ty = node.child_by_field_name("type")
            if ty is not None:
                self._call(_last_ident(ty), None, node)
        return False


def _descend(node: Any, types: tuple[str, ...], stop: tuple[str, ...] = ()) -> list[Any]:
    out: list[Any] = []
    if node is None:
        return out
    stack = [node]
    while stack:
        n = stack.pop()
        if n.type in stop:
            continue
        if n.type in types:
            out.append(n)
        stack.extend(reversed(n.children))
    return out


def _extract_ts(path: str, language: str, text: str) -> FileSymbols | None:
    parser = _parser(_lang_key(path, language))
    if parser is None:
        return None
    try:
        src = text.encode("utf-8")
        tree = parser.parse(src)
        return _Walker(path, language, src).run(tree.root_node)
    except Exception:
        return None


# ---------------------------------------------------------------- fallbacks

_KEYWORDS = frozenset(
    "if for while switch catch return function def class new typeof await async else elif with "
    "assert print super import from lambda not and or in is func go defer select case do try "
    "synchronized sizeof".split()
)  # fmt: skip
_CALL_RE = re.compile(r"(?<![\w$])(?:([A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(")
_COMPLEX_RE = re.compile(r"\b(?:if|for|while|case|catch|elif|except)\b|&&|\|\||\?\?")


def _py_fallback(path: str, text: str) -> FileSymbols:
    fs = FileSymbols(path, "Python", "fallback")
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError):
        return fs

    def walk(node: ast.AST, parents: list[Symbol], fn: Symbol | None) -> None:
        for child in ast.iter_child_nodes(node):
            cur_fn = fn
            nxt = parents
            if isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
                is_cls = isinstance(child, ast.ClassDef)
                owner = next((p.qname for p in reversed(parents) if p.kind == "class"), None)
                kind = "class" if is_cls else ("method" if parents and parents[-1].kind == "class" else "function")
                sym = Symbol(child.name, kind, path, child.lineno, child.end_lineno or child.lineno, owner)
                if not is_cls:
                    sym.complexity = 1 + sum(
                        isinstance(n, ast.If | ast.For | ast.AsyncFor | ast.While | ast.ExceptHandler | ast.IfExp | ast.BoolOp | ast.match_case)
                        for n in ast.walk(child)
                    )  # fmt: skip
                fs.symbols.append(sym)
                nxt = [*parents, sym]
                if not is_cls:
                    cur_fn = sym
            elif isinstance(child, ast.Import):
                for a in child.names:
                    fs.imports.append(ImportRef(a.name, [], child.lineno))
            elif isinstance(child, ast.ImportFrom):
                fs.imports.append(ImportRef(child.module or "", [a.name for a in child.names], child.lineno, child.level))
            elif isinstance(child, ast.Call):
                f = child.func
                caller = cur_fn.qname if cur_fn else None
                if isinstance(f, ast.Name):
                    fs.calls.append(CallRef(f.id, child.lineno, None, caller))
                elif isinstance(f, ast.Attribute):
                    q = ast.unparse(f.value) if isinstance(f.value, ast.Name | ast.Attribute) else None
                    fs.calls.append(CallRef(f.attr, child.lineno, q, caller))
            walk(child, nxt, cur_fn)

    walk(tree, [], None)
    return fs


_JS_DEFS = [
    (re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)"), "function"),
    (re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)"), "class"),
    (re.compile(r"^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)"), "interface"),
    (re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=>"), "function"),
    (re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b"), "function"),
]  # fmt: skip
_JS_METHOD = re.compile(
    r"^\s+(?:(?:public|private|protected|static|async|override|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^;]*\)\s*(?::\s*[^{;=]+)?\s*\{\s*$"
)
_JS_IMPORT = re.compile(
    r"""(?:import\s+(?:([^'"]*?)\s+from\s+)?|export\s+[^'"]*?\sfrom\s+|require\(\s*|import\(\s*)['"]([^'"]+)['"]"""
)
_GO_FUNC = re.compile(r"^func\s+(?:\(\s*\w*\s*\*?\s*(\w+)[^)]*\)\s*)?(\w+)\s*[(\[]")
_GO_TYPE = re.compile(r"^type\s+(\w+)\s+(struct|interface)?")
_GO_IMPORT = re.compile(r'^\s*(?:import\s+)?(?:(\w+)\s+)?"([^"]+)"\s*$')
_JAVA_TYPE = re.compile(r"^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*(class|interface|enum|record)\s+(\w+)")
_JAVA_METHOD = re.compile(
    r"^\s+(?:(?:public|private|protected|static|final|abstract|synchronized|default)\s+)*(?:<[^>]+>\s+)?(?:[\w<>\[\],.? ]+\s+)?(\w+)\s*\([^;]*\)\s*(?:throws [\w., ]+)?\s*\{\s*$"
)
_JAVA_IMPORT = re.compile(r"^\s*import\s+(?:static\s+)?([\w.*]+)\s*;")


def _brace_end(lines: list[str], start: int) -> int:
    depth, seen = 0, False
    for j in range(start, len(lines)):
        ln = re.sub(r"""(["'`])(?:\\.|(?!\1).)*\1""", "", lines[j])
        depth += ln.count("{") - ln.count("}")
        seen = seen or "{" in ln
        if seen and depth <= 0:
            return j
    return min(start, len(lines) - 1) if not seen else len(lines) - 1


def _brace_fallback(path: str, language: str, text: str) -> FileSymbols:
    fs = FileSymbols(path, language, "fallback")
    lines = text.splitlines()
    classes: list[Symbol] = []
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith(("//", "*", "/*")):
            continue
        sym: Symbol | None = None
        if language in ("JavaScript", "TypeScript"):
            for rx, kind in _JS_DEFS:
                m = rx.match(line)
                if m:
                    sym = Symbol(m.group(1), kind, path, i + 1, _brace_end(lines, i) + 1 if "{" in "".join(lines[i : i + 3]) else i + 1)
                    break
            if sym is None:
                m = _JS_METHOD.match(line)
                if m and m.group(1) not in _KEYWORDS:
                    sym = Symbol(m.group(1), "constructor" if m.group(1) == "constructor" else "method", path, i + 1, _brace_end(lines, i) + 1)
        elif language == "Go":
            m = _GO_FUNC.match(line)
            if m:
                sym = Symbol(m.group(2), "method" if m.group(1) else "function", path, i + 1, _brace_end(lines, i) + 1, m.group(1))
            else:
                m = _GO_TYPE.match(line)
                if m:
                    sym = Symbol(m.group(1), m.group(2) or "type", path, i + 1, _brace_end(lines, i) + 1 if m.group(2) else i + 1)
        elif language == "Java":
            m = _JAVA_TYPE.match(line)
            if m:
                sym = Symbol(m.group(2), "class" if m.group(1) in ("class", "record") else m.group(1), path, i + 1, _brace_end(lines, i) + 1)
            else:
                m = _JAVA_METHOD.match(line)
                if m and m.group(1) not in _KEYWORDS and classes:
                    sym = Symbol(m.group(1), "method", path, i + 1, _brace_end(lines, i) + 1)
        if sym is not None:
            if sym.kind in ("class", "interface", "enum", "struct"):
                classes.append(sym)
            elif sym.kind in ("method", "constructor") and language != "Go":
                owner = next((c for c in reversed(classes) if c.line <= sym.line <= c.end_line), None)
                sym.parent = owner.qname if owner else None
            fs.symbols.append(sym)
    # imports
    for i, line in enumerate(lines):
        if language in ("JavaScript", "TypeScript"):
            for m in _JS_IMPORT.finditer(line):
                names = re.findall(r"[A-Za-z_$][\w$]*", (m.group(1) or "").replace(" as ", " "))
                fs.imports.append(ImportRef(m.group(2), [n for n in names if n != "type"], i + 1))
        elif language == "Go":
            m = _GO_IMPORT.match(line)
            if m and (line.lstrip().startswith(("import", '"')) or m.group(1)):
                fs.imports.append(ImportRef(m.group(2), [m.group(1)] if m.group(1) else [], i + 1))
        elif language == "Java":
            m = _JAVA_IMPORT.match(line)
            if m:
                fs.imports.append(ImportRef(m.group(1), [], i + 1))
    # calls + complexity from function bodies
    funcs = [s for s in fs.symbols if s.kind in FUNC_KINDS]
    for s in funcs:
        s.complexity = 1 + len(_COMPLEX_RE.findall("\n".join(lines[s.line - 1 : s.end_line])))
    for i, line in enumerate(lines):
        if line.strip().startswith(("//", "*", "/*", "import ")):
            continue
        owner = min(
            (s for s in funcs if s.line <= i + 1 <= s.end_line),
            key=lambda s: s.end_line - s.line, default=None,
        )  # fmt: skip
        for m in _CALL_RE.finditer(line):
            name = m.group(2)
            if name in _KEYWORDS or any(s.line == i + 1 and s.name == name for s in fs.symbols):
                continue
            fs.calls.append(CallRef(name, i + 1, m.group(1), owner.qname if owner else None))
    return fs


# ---------------------------------------------------------------- public API


def analyze_file(path: str, language: str, text: str) -> FileSymbols | None:
    """Return symbols/imports/calls for one file, or None for unsupported languages."""
    if language not in SUPPORTED:
        return None
    if len(text) <= MAX_PARSE_BYTES:
        res = _extract_ts(path, language, text)
        if res is not None:
            return res
    if language == "Python":
        return _py_fallback(path, text)
    return _brace_fallback(path, language, text)
