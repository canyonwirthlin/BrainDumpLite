"""Generate docs/CODEMAP.md: a compact, machine-derived map of the codebase.

Why: a fresh agent (or sub-agent) starts with zero knowledge of the repo and spends thousands of tokens
reading files just to learn what lives where. This map is the answer to "what is each file for, what does
it depend on, which endpoints exist and who calls them, what is in the database" in one short read.
It holds structure only (names, one-line purposes, edges), never code, and is rebuilt from the source:

    .venv/Scripts/python scripts/codemap.py            # rewrite docs/CODEMAP.md
    .venv/Scripts/python scripts/codemap.py --check    # exit 1 if the file is out of date

Stdlib only. The database section is read from a throwaway vault in a temp dir, never the real one.
"""
from __future__ import annotations

import ast
import os
import re
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "CODEMAP.md"
HTTP = {"get", "post", "put", "patch", "delete"}
MAX_DEFS = 14      # public names listed per module before "+N more"
MAX_LIST = 6       # importers / callers listed before "+N"


def _rel(p: Path) -> str:
    return p.relative_to(ROOT).as_posix()


def _cap(items, n=MAX_LIST) -> str:
    items = list(items)
    return ", ".join(items[:n]) + (f" +{len(items) - n}" if len(items) > n else "")


def _first_line(text: str | None, limit: int = 120) -> str:
    for line in (text or "").splitlines():
        line = line.strip()
        if line:
            return line[:limit]
    return ""


# ── Python ───────────────────────────────────────────────────────────────────

def _py_files() -> list[Path]:
    files = sorted((ROOT / "app").glob("*.py"))
    run = ROOT / "run.py"
    return files + ([run] if run.exists() else [])


def _py_imports(tree: ast.AST, modules: set[str]) -> set[str]:
    """Names of app modules this file imports (function-level imports included)."""
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            if node.level >= 1 or mod == "app" or mod.startswith("app."):
                base = mod.removeprefix("app.").removeprefix("app")
                if base and base.split(".")[0] in modules:
                    out.add(base.split(".")[0])
                elif not base:
                    out.update(a.name for a in node.names if a.name in modules)
        elif isinstance(node, ast.Import):
            for a in node.names:
                if a.name.startswith("app."):
                    seg = a.name.split(".")[1]
                    if seg in modules:
                        out.add(seg)
    return out


def _routes(tree: ast.Module) -> list[tuple[str, str, str]]:
    """(METHOD, path, handler) for every @<router>.<verb>("/path") decorator, in source order."""
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for dec in node.decorator_list:
            f = getattr(dec, "func", None)
            if (isinstance(f, ast.Attribute) and f.attr in HTTP and isinstance(f.value, ast.Name)
                    and dec.args and isinstance(dec.args[0], ast.Constant) and isinstance(dec.args[0].value, str)):
                prefix = "" if f.value.id == "oauth_router" else "/api"
                out.append((f.attr.upper(), prefix + dec.args[0].value, node.name, node.lineno))
    out.sort(key=lambda r: r[3])
    return [(m, p, h) for m, p, h, _ in out]


def scan_python() -> dict:
    files = _py_files()
    modules = {p.stem for p in (ROOT / "app").glob("*.py")}
    info: dict[str, dict] = {}
    for p in files:
        text = p.read_text(encoding="utf-8")
        tree = ast.parse(text)
        routes = _routes(tree)
        handlers = {h for _, _, h in routes}
        defs = [n.name for n in tree.body
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                and not n.name.startswith("_") and n.name not in handlers]
        name = p.stem if p.parent.name == "app" else "run"
        info[name] = {"path": _rel(p), "loc": text.count("\n") + 1, "doc": _first_line(ast.get_docstring(tree)),
                      "deps": _py_imports(tree, modules) - {name}, "defs": defs, "routes": routes}
    tests: dict[str, set[str]] = defaultdict(set)
    for p in sorted((ROOT / "tests").glob("test_*.py")):
        try:
            for mod in _py_imports(ast.parse(p.read_text(encoding="utf-8")), modules):
                tests[mod].add(p.stem.removeprefix("test_"))
        except SyntaxError:
            pass
    used_by: dict[str, set[str]] = defaultdict(set)
    for name, d in info.items():
        for dep in d["deps"]:
            used_by[dep].add(name)
    for name, d in info.items():
        d["used_by"] = sorted(used_by[name])
        d["tests"] = sorted(tests[name])
    return info


# ── JavaScript ───────────────────────────────────────────────────────────────

_JS_IMPORT = re.compile(r"""import\s+(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)""")
_JS_EXPORT = re.compile(r"^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+(\w+)", re.M)
_JS_EXPORT_LIST = re.compile(r"^export\s*\{([^}]*)\}", re.M)
_JS_API = re.compile(r"""\bapi\.(get|post|put|patch|del)\(\s*(?:`([^`]*)`|"([^"]*)"|'([^']*)')""")
_JS_FETCH = re.compile(r"""\bfetch\(\s*(?:`([^`]*)`|"([^"]*)")([^;]{0,160})""")


def _js_leading_comment(text: str) -> str:
    for line in text.splitlines()[:6]:
        s = line.strip()
        if s.startswith("//"):
            return s.lstrip("/ ").strip()[:120]
        if s.startswith("/*"):
            return s.strip("/* ").strip()[:120]
        if s:
            break
    return ""


def _norm_call(path: str) -> str:
    path = re.sub(r"\$\{[^}]*\}", "\x00", path.split("?")[0])
    path = re.sub(r"(?<=[^/])\x00", "", path)           # `/tasks${qs}`: a query suffix, not a path segment
    return path.replace("\x00", "{}").rstrip("/") or "/"


def scan_js() -> tuple[dict, list[tuple[str, str, str]]]:
    base = ROOT / "static" / "js"
    files = sorted(base.rglob("*.js"))
    keyed = {_rel(p): p for p in files}
    info: dict[str, dict] = {}
    calls: list[tuple[str, str, str]] = []     # (method, normalised path, js file key)
    for p in files:
        text = p.read_text(encoding="utf-8")
        key = p.relative_to(base).with_suffix("").as_posix()
        deps = set()
        for m in _JS_IMPORT.finditer(text):
            spec = m.group(1) or m.group(2)
            if spec.startswith("."):
                target = (p.parent / spec).resolve()
                try:
                    rel = _rel(target)
                except ValueError:
                    continue
                if rel in keyed:
                    deps.add(target.relative_to(base).with_suffix("").as_posix())
        exports = _JS_EXPORT.findall(text)
        for grp in _JS_EXPORT_LIST.findall(text):
            exports += [x.split(" as ")[-1].strip() for x in grp.split(",") if x.strip()]
        if re.search(r"^export\s+default", text, re.M):
            exports.append("default")
        mine = set()
        for m in _JS_API.finditer(text):
            verb = "DELETE" if m.group(1) == "del" else m.group(1).upper()
            raw = next(g for g in m.groups()[1:] if g is not None)
            mine.add((verb, _norm_call(raw)))
        for m in _JS_FETCH.finditer(text):
            raw = m.group(1) or m.group(2)
            if raw.startswith("/api/"):
                verb = (re.search(r"""method:\s*["'](\w+)["']""", m.group(3)) or [None, "GET"])[1].upper()
                mine.add((verb, _norm_call(raw[4:])))
        calls += [(v, pth, key) for v, pth in mine]
        info[key] = {"path": _rel(p), "loc": text.count("\n") + 1, "doc": _js_leading_comment(text),
                     "deps": deps - {key}, "exports": sorted(set(exports)), "calls": sorted(mine)}
    used_by: dict[str, set[str]] = defaultdict(set)
    for k, d in info.items():
        for dep in d["deps"]:
            used_by[dep].add(k)
    for k, d in info.items():
        d["used_by"] = sorted(used_by[k])
    return info, calls


def _seg_match(call: str, route: str) -> bool:
    a, b = call.strip("/").split("/"), re.sub(r"\{[^}]*\}", "{}", route).strip("/").split("/")
    return len(a) == len(b) and all(x == y or x == "{}" or y == "{}" for x, y in zip(a, b))


def route_callers(routes_by_mod: dict, calls: list) -> dict[tuple[str, str], set[str]]:
    """{(METHOD, route path as declared): {js files that call it}}. A static route beats a {wildcard} one."""
    api_routes = [(m, p) for rs in routes_by_mod.values() for m, p, _ in rs if p.startswith("/api/")]
    out: dict[tuple[str, str], set[str]] = defaultdict(set)
    for verb, path, key in calls:
        hits = [(m, p) for m, p in api_routes if m == verb and _seg_match(path, p[4:])]
        static = [h for h in hits if "{" not in h[1]]
        for h in (static or hits):
            out[h].add(key)
    return out


# ── Database (read from a throwaway vault) ───────────────────────────────────

def scan_db() -> list[tuple[str, list[str], bool]] | None:
    """[(table, columns, is_virtual)]. None if the schema can't be built here."""
    old = os.environ.get("BRAINDUMP_LITE_DATA")
    db = None
    saved_conn = None
    try:
        with tempfile.TemporaryDirectory(prefix="bdl-codemap-", ignore_cleanup_errors=True) as tmp:
            os.environ["BRAINDUMP_LITE_DATA"] = tmp
            sys.path.insert(0, str(ROOT))
            from app import db
            saved_conn, db._conn = db._conn, None     # a private connection, so a caller's open vault (e.g. pytest) is untouched
            db.init_db()
            c = db.conn()
            rows = c.execute("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").fetchall()
            virtual = {r["name"] for r in rows if (r["sql"] or "").upper().startswith("CREATE VIRTUAL")}
            out = []
            for r in rows:
                n = r["name"]
                if n not in virtual and any(n.startswith(v + "_") for v in virtual):
                    continue    # FTS shadow tables
                cols = [x["name"] for x in c.execute(f"PRAGMA table_info({n})")]
                out.append((n, cols, n in virtual))
            c.close()
            return out
    except Exception as e:      # the map is still useful without this section
        print(f"codemap: skipped database section ({e})", file=sys.stderr)
        return None
    finally:
        if db is not None:
            db._conn = saved_conn
        if old is None:
            os.environ.pop("BRAINDUMP_LITE_DATA", None)
        else:
            os.environ["BRAINDUMP_LITE_DATA"] = old


# ── Render ───────────────────────────────────────────────────────────────────

def render() -> str:
    py = scan_python()
    js, calls = scan_js()
    callers = route_callers({k: v["routes"] for k, v in py.items()}, calls)
    db_tables = scan_db()
    L: list[str] = []
    add = L.append

    add("# Code map")
    add("")
    add("> Generated by `scripts/codemap.py`: structure only (purposes, imports, endpoints, tables), no code. "
        "Do not edit by hand; regenerate with `.venv/Scripts/python scripts/codemap.py`.")
    add("")
    add("**How to use (agents and sub-agents):** read this file first, pick the few files that matter, and open only those. "
        "`deps` = imports it uses, `used by` = who imports it (blast radius), `tests` = `tests/test_<name>.py` files that import it, "
        "`←` after an endpoint = frontend files that call it. Paths are repo-relative; backend routes are under `/api` "
        "(except `oauth_router`). Stack notes and rules live in `CLAUDE.md`.")
    add("")

    add("## Hot spots (most imported, so edit with care)")
    add("")
    hot_py = sorted(py.items(), key=lambda kv: (-len(kv[1]["used_by"]), kv[0]))[:6]
    hot_js = sorted(js.items(), key=lambda kv: (-len(kv[1]["used_by"]), kv[0]))[:6]
    add("- Backend: " + ", ".join(f"`{k}` ({len(v['used_by'])})" for k, v in hot_py))
    add("- Frontend: " + ", ".join(f"`{k}` ({len(v['used_by'])})" for k, v in hot_js))
    add("")

    if db_tables:
        add("## Database (SQLite, `app/db.py`: `SCHEMA` + additive `_migrate()`)")
        add("")
        for name, cols, virt in db_tables:
            add(f"- `{name}`{' (FTS)' if virt else ''}: {', '.join(cols)}")
        add("")

    add(f"## Backend: `app/` ({len(py)} modules)")
    add("")
    for name in sorted(py):
        d = py[name]
        add(f"### `{d['path']}` ({d['loc']} loc)")
        if d["doc"]:
            add(d["doc"])
        meta = []
        if d["deps"]:
            meta.append("deps: " + ", ".join(sorted(d["deps"])))
        if d["used_by"]:
            meta.append(f"used by ({len(d['used_by'])}): " + _cap(d["used_by"]))
        if d["tests"]:
            meta.append("tests: " + _cap(d["tests"]))
        if meta:
            add("- " + " · ".join(meta))
        if d["defs"]:
            add("- defs: " + _cap(d["defs"], MAX_DEFS))
        if d["routes"]:
            add("- endpoints:")
            for m, p, h in d["routes"]:
                who = sorted(callers.get((m, p), ()))
                add(f"  - `{m} {p}` → {h}" + (f" ← {_cap(who, 4)}" if who else ""))
        add("")

    add(f"## Frontend: `static/js/` ({len(js)} modules, no build step; `views/*` are the tabs)")
    add("")
    for key in sorted(js):
        d = js[key]
        add(f"### `{d['path']}` ({d['loc']} loc)")
        if d["doc"]:
            add(d["doc"])
        meta = []
        if d["deps"]:
            meta.append("imports: " + ", ".join(sorted(d["deps"])))
        if d["used_by"]:
            meta.append(f"used by ({len(d['used_by'])}): " + _cap(d["used_by"]))
        if meta:
            add("- " + " · ".join(meta))
        if d["exports"]:
            add("- exports: " + _cap(d["exports"], MAX_DEFS))
        if d["calls"]:
            add("- calls: " + _cap((f"{v} {p}" for v, p in d["calls"]), 8))
        add("")

    return "\n".join(L).rstrip() + "\n"


def main(argv: list[str]) -> int:
    text = render()
    if "--check" in argv:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if current != text:
            print("docs/CODEMAP.md is out of date. Run: .venv/Scripts/python scripts/codemap.py", file=sys.stderr)
            return 1
        print("docs/CODEMAP.md is up to date")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(f"wrote {_rel(OUT)}: {len(text.splitlines())} lines, {len(text):,} chars (~{len(text) // 4:,} tokens)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
