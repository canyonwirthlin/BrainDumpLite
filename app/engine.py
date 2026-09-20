"""Built-in AI: a managed llama.cpp server + curated models. Zero setup.

The app already speaks the OpenAI protocol to any base_url (see ai.py), so
"builtin" mode simply makes the app OWN the local server instead of hoping
the user runs LM Studio/Ollama:

  1. First run: download the pinned llama.cpp release (llama-server.exe,
     Vulkan build — one ~30 MB binary accelerates NVIDIA, AMD and Intel GPUs
     and quietly runs on CPU when no usable driver exists) plus the GGUF
     model the user picked from a short VRAM-labelled list. Every download
     is sha256-verified and resumable; files live in the per-user data dir.
  2. Every launch (and lazily on first use): spawn llama-server on a
     loopback port, wait for /health, point the "builtin" provider at it.
     A second tiny server runs the embedding model CPU-only, so semantic
     search works — something the old LM Studio setup usually missed.
  3. Server processes are tied to a Windows Job Object with
     KILL_ON_JOB_CLOSE, so they can never outlive the app — even when the
     console window is closed with the X.

Stdlib only, on purpose: update bundles (push-update.bat) cannot add pip
packages to friends' frozen exes, and this module ships as an update.
"""
from __future__ import annotations

import atexit
import ctypes
import hashlib
import os
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.request
import zipfile
from pathlib import Path

from . import catalog, db

# run.py injects truststore for the frozen app; repeat it here so engine
# downloads also survive AV/corporate TLS interception when running from
# source (dev mode). Harmless if already injected or unavailable.
try:
    import truststore
    truststore.inject_into_ssl()
except Exception:
    pass

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

# ── Pinned artifacts ─────────────────────────────────────────────────────────
# llama.cpp release (github.com/ggml-org/llama.cpp). sha256 values come from
# the GitHub release-asset digests; bump tag + hash together. Deliberately a
# few weeks behind latest: AV reputation systems (Avast CyberCapture etc.)
# false-positive brand-new unsigned exes, and an older build has had time to
# accumulate clean verdicts. Observed live: Avast quarantined a 0-day-old
# llama-server.exe mid-run.
LLAMA_TAG = "b9658"
ENGINE_ZIP = {
    "name": f"llama-{LLAMA_TAG}-bin-win-vulkan-x64.zip",
    "url": ("https://github.com/ggml-org/llama.cpp/releases/download/"
            f"{LLAMA_TAG}/llama-{LLAMA_TAG}-bin-win-vulkan-x64.zip"),
    "sha256": "4c70fc1048cb6d4b243ff06632d43b8fc2a303488ab8b6ab7cc3d088844db1b4",
}

# Chat models come from the curated catalog (catalog/models.json, refreshed
# from the repo at most daily). Nothing downloads until the user presses Get.
def CHAT_MODELS() -> list[dict]:
    return catalog.chat_models()


EMBED_MODEL = {
    "id": "nomic-embed",
    "repo": "nomic-ai/nomic-embed-text-v1.5-GGUF",
    "file": "nomic-embed-text-v1.5.Q8_0.gguf",
    "sha256": "3e24342164b3d94991ba9692fdc0dd08e3fd7362e0aacc396a9a5c54a544c3b7",
    "size": 146146432,
}

# Ports: run.py scans 8756-8780 for the web app — stay clear of that range.
CHAT_PORT_BASE = 8790
EMBED_PORT_BASE = 8820

# ── Module state ─────────────────────────────────────────────────────────────

_proc_lock = threading.RLock()      # guards the two server processes
_chat_proc: subprocess.Popen | None = None
_chat_port = 0
_chat_model = ""                    # registry id currently loaded
_embed_proc: subprocess.Popen | None = None
_embed_port = 0
_embed_failed_at = 0.0              # throttle embed respawn attempts

IDLE_OFFLOAD_S = 600                # unload after 10 idle minutes — RAM/VRAM back when not dumping
_chat_last_used = 0.0
_embed_last_used = 0.0

_progress_lock = threading.Lock()   # guards _progress
_progress = {"phase": "idle", "message": "", "pct": None, "done_mb": 0, "total_mb": 0}

_job = None                         # Windows Job Object handle
_gpu: dict | None = None            # cached detect_gpu() result


# ── Paths / registry helpers ─────────────────────────────────────────────────

def engine_dir() -> Path:
    p = db.data_dir() / "engine"
    p.mkdir(parents=True, exist_ok=True)
    return p


def models_dir() -> Path:
    p = db.data_dir() / "models" / "llm"
    p.mkdir(parents=True, exist_ok=True)
    return p


def server_exe() -> Path | None:
    d = engine_dir() / LLAMA_TAG
    if d.is_dir():
        hit = next(d.rglob("llama-server.exe"), None)
        if hit:
            return hit
    return None


def model_path(meta: dict) -> Path:
    return models_dir() / meta["file"]


def _model_by_id(mid: str) -> dict | None:
    return next((m for m in CHAT_MODELS() if m["id"] == mid), None)


def _file_ok(meta: dict) -> bool:
    p = model_path(meta)
    try:
        return p.exists() and p.stat().st_size == meta["size"]
    except OSError:
        return False


def active_model() -> str:
    return db.get_setting("builtin_model", "") or ""


def engine_zip_path() -> Path:
    return engine_dir() / ENGINE_ZIP["name"]


def is_configured() -> bool:
    # The exe missing but the zip cached still counts as configured: AV likes
    # to quarantine llama-server.exe, and we can re-extract it on demand.
    m = _model_by_id(active_model())
    return (os.name == "nt" and m is not None and _file_ok(m)
            and (server_exe() is not None or engine_zip_path().exists()))


def chat_base_url() -> str:
    with _proc_lock:
        if _chat_proc is not None and _chat_proc.poll() is None and _chat_port:
            return f"http://127.0.0.1:{_chat_port}/v1"
    return ""


def embed_base_url() -> str:
    with _proc_lock:
        if _embed_proc is not None and _embed_proc.poll() is None and _embed_port:
            return f"http://127.0.0.1:{_embed_port}/v1"
    return ""


# ── GPU detection (recommendation only — the user can always override) ──────

def detect_gpu() -> dict:
    global _gpu
    if _gpu is not None:
        return _gpu
    gpu = {"name": None, "vram_mb": 0}
    # nvidia-smi is authoritative when present.
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=8, creationflags=CREATE_NO_WINDOW)
        line = (out.stdout or "").strip().splitlines()
        if out.returncode == 0 and line:
            name, mem = line[0].rsplit(",", 1)
            gpu = {"name": name.strip(), "vram_mb": int(float(mem.strip()))}
    except Exception:
        pass
    # Any-vendor fallback: the display-class registry key. qwMemorySize is a
    # QWORD and correct above 4 GB (unlike WMI's uint32 AdapterRAM).
    if not gpu["vram_mb"] and os.name == "nt":
        try:
            import winreg
            base = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"
            best = ("", 0)
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, base) as k:
                i = 0
                while True:
                    try:
                        sub = winreg.EnumKey(k, i)
                    except OSError:
                        break
                    i += 1
                    if not re.fullmatch(r"\d{4}", sub):
                        continue
                    try:
                        with winreg.OpenKey(k, sub) as sk:
                            mem, _ = winreg.QueryValueEx(sk, "HardwareInformation.qwMemorySize")
                            name = ""
                            try:
                                name, _ = winreg.QueryValueEx(sk, "DriverDesc")
                            except OSError:
                                pass
                            if isinstance(mem, int) and mem > best[1]:
                                best = (str(name), mem)
                    except OSError:
                        continue
            if best[1]:
                gpu = {"name": best[0] or None, "vram_mb": best[1] // (1024 * 1024)}
        except Exception:
            pass
    _gpu = gpu
    return gpu


def recommended_id(vram_mb: int) -> str:
    # Biggest model whose VRAM tier fits, with ~600 MB headroom because Windows
    # itself holds VRAM. Ties go to the catalog's first entry in that tier.
    models = CHAT_MODELS()
    fits = [m for m in models if vram_mb >= m["vram_gb"] * 1024 - 600]
    if not fits:
        return min(models, key=lambda m: m["vram_gb"])["id"] if models else ""
    best = max(m["vram_gb"] for m in fits)
    return next(m["id"] for m in fits if m["vram_gb"] == best)


# ── Progress reporting ───────────────────────────────────────────────────────

def _phase(phase: str, message: str = "", pct=None, done_mb=0, total_mb=0) -> None:
    global _progress
    with _progress_lock:
        _progress = {"phase": phase, "message": message, "pct": pct,
                     "done_mb": done_mb, "total_mb": total_mb}


def setup_progress() -> dict:
    with _progress_lock:
        return dict(_progress)


# ── Downloads (resumable, sha256-verified) ───────────────────────────────────

def _download(url: str, dest: Path, sha256: str, expect_size: int | None, phase: str, label: str) -> None:
    part = dest.with_name(dest.name + ".part")
    last_err: Exception | None = None
    for attempt in range(4):
        try:
            have = part.stat().st_size if part.exists() else 0
            if expect_size is None or have < expect_size:
                req = urllib.request.Request(url, headers={"User-Agent": "BrainDumpLite"})
                if have:
                    req.add_header("Range", f"bytes={have}-")
                with urllib.request.urlopen(req, timeout=60) as r:
                    if have and r.status != 206:  # server ignored Range — start over
                        have = 0
                    total = expect_size or have + int(r.headers.get("Content-Length") or 0)
                    with open(part, "ab" if have else "wb") as f:
                        while True:
                            chunk = r.read(1 << 18)
                            if not chunk:
                                break
                            f.write(chunk)
                            have += len(chunk)
                            _phase(phase, label,
                                   pct=round(have / total * 100, 1) if total else None,
                                   done_mb=have >> 20, total_mb=total >> 20)
            if expect_size is not None and part.stat().st_size < expect_size:
                raise OSError(f"connection dropped at {have >> 20} MB")  # → resume on retry
            last_err = None
            break
        except (OSError, ValueError) as e:
            last_err = e
            time.sleep(2 * (attempt + 1))
    if last_err is not None:
        raise RuntimeError(f"download failed after retries: {last_err}")

    _phase(phase, f"Verifying {label}…", pct=None)
    h = hashlib.sha256()
    with open(part, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    if h.hexdigest().lower() != sha256.lower():
        part.unlink(missing_ok=True)
        raise RuntimeError(f"{label}: sha256 mismatch — corrupted or tampered download, please retry")
    part.replace(dest)


_AV_HELP = ("Your antivirus removed the AI engine (llama-server.exe) — a "
            "common false positive for new unsigned programs. To fix it: open "
            "your antivirus (Avast/AVG: Menu → Settings → General → "
            "Exceptions; Defender: Virus protection → Exclusions), add an "
            "exception for the folder below, restore the file from Quarantine "
            "if it's listed there, then press the model button again. Folder: ")


def _extract_engine() -> Path:
    """Unpack the cached zip into engine/<tag>/. The zip is KEPT after
    extraction so an AV-quarantined exe can be restored without a network."""
    zpath = engine_zip_path()
    target = engine_dir() / LLAMA_TAG
    tmp = engine_dir() / f".extract-{LLAMA_TAG}"
    if tmp.exists():
        shutil.rmtree(tmp)
    with zipfile.ZipFile(zpath) as z:
        for name in z.namelist():  # zip-slip guard
            if name.startswith(("/", "..")) or ".." in Path(name).parts:
                raise RuntimeError(f"unsafe path in engine zip: {name}")
        z.extractall(tmp)
    if target.exists():
        shutil.rmtree(target)
    tmp.replace(target)
    # Tidy superseded engine versions (a tag bump arrives via app update).
    for d in engine_dir().iterdir():
        if d.is_dir() and d.name != LLAMA_TAG and not d.name.startswith("."):
            shutil.rmtree(d, ignore_errors=True)
    exe = server_exe()
    if not exe:
        raise RuntimeError("engine zip did not contain llama-server.exe")
    return exe


def _ensure_engine() -> Path:
    exe = server_exe()
    if exe:
        return exe
    if not engine_zip_path().exists():
        _download(ENGINE_ZIP["url"], engine_zip_path(), ENGINE_ZIP["sha256"], None,
                  "engine", "AI engine (llama.cpp)")
    return _extract_engine()


def _exe_or_repair() -> Path:
    """The server exe, re-extracted from the cached zip if AV deleted it."""
    exe = server_exe()
    if exe:
        return exe
    if engine_zip_path().exists():
        try:
            exe = _extract_engine()
            print("[engine] llama-server.exe was missing — restored from cached zip "
                  "(antivirus quarantine?)", flush=True)
            return exe
        except Exception:
            pass
    raise RuntimeError(_AV_HELP + str(engine_dir()))


def _ensure_model_file(meta: dict, phase: str, label: str) -> None:
    if _file_ok(meta):
        return
    url = f"https://huggingface.co/{meta['repo']}/resolve/main/{meta['file']}"
    _download(url, model_path(meta), meta["sha256"], meta["size"], phase, label)


# ── Process management ───────────────────────────────────────────────────────

def _make_job():
    """Job object that kills every assigned process when our process dies."""
    from ctypes import wintypes
    k32 = ctypes.windll.kernel32

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [(n, ctypes.c_uint64) for n in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class BASIC_LIMITS(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64),
                    ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD),
                    ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t),
                    ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t),
                    ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class EXTENDED_LIMITS(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BASIC_LIMITS),
                    ("IoInfo", IO_COUNTERS),
                    ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t)]

    k32.CreateJobObjectW.restype = wintypes.HANDLE
    job = k32.CreateJobObjectW(None, None)
    if not job:
        return None
    info = EXTENDED_LIMITS()
    info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    k32.SetInformationJobObject(wintypes.HANDLE(job), 9,  # JobObjectExtendedLimitInformation
                                ctypes.byref(info), ctypes.sizeof(info))
    return job


def _assign_job(proc: subprocess.Popen) -> None:
    global _job
    if os.name != "nt":
        return
    try:
        from ctypes import wintypes
        if _job is None:
            _job = _make_job()
        if _job:
            ctypes.windll.kernel32.AssignProcessToJobObject(
                wintypes.HANDLE(_job), wintypes.HANDLE(int(proc._handle)))
    except Exception:
        pass  # cleanup still happens via atexit terminate


def _free_port(start: int) -> int:
    for p in range(start, start + 20):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise RuntimeError("no free local port for the AI engine")


def _log_path(name: str) -> Path:
    return db.data_dir() / name


def _log_tail(name: str, chars: int = 700) -> str:
    try:
        text = _log_path(name).read_text(encoding="utf-8", errors="replace")
        return text[-chars:].strip()
    except OSError:
        return ""


def _spawn(args: list[str], logname: str) -> subprocess.Popen:
    with open(_log_path(logname), "w", encoding="utf-8", errors="replace") as log:
        proc = subprocess.Popen(
            args, stdout=log, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW)
    _assign_job(proc)
    return proc


def _wait_health(port: int, proc: subprocess.Popen, logname: str, timeout: float) -> None:
    """llama-server: /health is 503 while the model loads, 200 when ready."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"engine exited during startup: …{_log_tail(logname)}")
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=3) as r:
                if r.status == 200:
                    return
        except OSError:
            pass
        time.sleep(0.5)
    proc.terminate()
    raise RuntimeError("engine did not become ready in time")


def _stop(proc: subprocess.Popen | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def stop_all() -> None:
    global _chat_proc, _embed_proc, _chat_model
    with _proc_lock:
        _stop(_chat_proc)
        _stop(_embed_proc)
        _chat_proc = _embed_proc = None
        _chat_model = ""


atexit.register(stop_all)


def _idle_watchdog() -> None:
    """Runs for the life of the app: offloads the chat/embed servers after
    IDLE_OFFLOAD_S with no use, so the model only sits in RAM/VRAM while a
    dump is actually being processed. Restarts lazily on the next call."""
    global _chat_proc, _chat_model, _embed_proc
    while True:
        time.sleep(60)
        now = time.time()
        with _proc_lock:
            if _chat_proc is not None and now - _chat_last_used > IDLE_OFFLOAD_S:
                _stop(_chat_proc)
                _chat_proc, _chat_model = None, ""
                print("[engine] chat model offloaded (idle)", flush=True)
            if _embed_proc is not None and now - _embed_last_used > IDLE_OFFLOAD_S:
                _stop(_embed_proc)
                _embed_proc = None
                print("[engine] embedding model offloaded (idle)", flush=True)


threading.Thread(target=_idle_watchdog, daemon=True).start()


def _start_chat_locked(meta: dict) -> None:
    """Start (or restart) the chat server. Tries full GPU offload first; if
    the server dies during load (usually VRAM exhaustion), falls back to CPU
    so the feature never hard-fails on a weak machine."""
    global _chat_proc, _chat_port, _chat_model
    _stop(_chat_proc)
    _chat_proc, _chat_model = None, ""
    exe = _exe_or_repair()
    port = _free_port(CHAT_PORT_BASE)
    last_err = None
    for ngl in ("99", "0"):
        proc = _spawn([str(exe), "-m", str(model_path(meta)),
                       "--host", "127.0.0.1", "--port", str(port),
                       "-c", "8192", "-ngl", ngl, "--jinja"], "engine-chat.log")
        try:
            _wait_health(port, proc, "engine-chat.log", timeout=420)
            _chat_proc, _chat_port, _chat_model = proc, port, meta["id"]
            if ngl == "0":
                print("[engine] GPU load failed — running on CPU", flush=True)
            return
        except RuntimeError as e:
            last_err = e
            _stop(proc)
            if not exe.exists():  # died AND vanished = AV pulled it mid-run
                raise RuntimeError(_AV_HELP + str(engine_dir()))
    raise RuntimeError(f"could not start the AI engine: {last_err}")


def ensure_chat_running() -> None:
    """Blocks until the chat server is up (model load can take ~10-60 s).
    A missing exe is NOT "not set up" — _exe_or_repair re-extracts it from
    the cached zip (AV quarantine is a fact of life, observed live)."""
    mid = active_model()
    meta = _model_by_id(mid)
    if not is_configured() or meta is None:
        raise RuntimeError("Built-in AI isn't set up yet — open Settings and pick a model")
    global _chat_last_used
    with _proc_lock:
        _chat_last_used = time.time()
        if _chat_proc is not None and _chat_proc.poll() is None and _chat_model == mid:
            return
        _start_chat_locked(meta)


def ensure_embed_running() -> bool:
    """Best-effort: embeddings are a bonus, never an error. CPU-only — the
    137M-param model is fast anyway and this keeps VRAM for the chat model."""
    global _embed_proc, _embed_port, _embed_failed_at, _embed_last_used
    if not _file_ok(EMBED_MODEL):
        return False
    with _proc_lock:
        _embed_last_used = time.time()
        if _embed_proc is not None and _embed_proc.poll() is None:
            return True
        if time.time() - _embed_failed_at < 300:  # don't respawn-loop a broken setup
            return False
        try:
            port = _free_port(EMBED_PORT_BASE)
            proc = _spawn([str(_exe_or_repair()), "-m", str(model_path(EMBED_MODEL)),
                           "--host", "127.0.0.1", "--port", str(port),
                           "--embeddings", "--pooling", "mean",
                           "-c", "2048", "-b", "2048", "-ub", "2048",
                           "-ngl", "0"], "engine-embed.log")
            _wait_health(port, proc, "engine-embed.log", timeout=120)
            _embed_proc, _embed_port = proc, port
            return True
        except Exception as e:
            print(f"[engine] embedding server unavailable: {e}", flush=True)
            _embed_failed_at = time.time()
            return False


def autostart() -> None:
    """Warm the servers at app boot so the first dump isn't slow."""
    if db.get_setting("provider") != "builtin" or not is_configured():
        return

    def warm():
        try:
            ensure_chat_running()
            ensure_embed_running()
        except Exception as e:
            print(f"[engine] warm start failed (will retry on first use): {e}", flush=True)

    threading.Thread(target=warm, daemon=True).start()


# ── Setup orchestration (background thread, progress polled by the UI) ──────

def start_setup(model_id: str) -> tuple[bool, str]:
    if os.name != "nt":
        return False, "Built-in AI is only available on Windows"
    meta = _model_by_id(model_id)
    if meta is None:
        return False, "Unknown model"
    with _progress_lock:
        if _progress["phase"] in ("queued", "engine", "model", "embed", "starting"):
            return False, "Setup is already running"
        _progress.update(phase="queued", message="", pct=None, done_mb=0, total_mb=0)
    threading.Thread(target=_run_setup, args=(meta,), daemon=True).start()
    return True, "started"


def _run_setup(meta: dict) -> None:
    try:
        _phase("engine", "AI engine")
        _ensure_engine()
        _phase("model", meta["label"])
        _ensure_model_file(meta, "model", meta["label"])
        try:  # embeddings are optional — a failure here must not fail setup
            _phase("embed", "semantic search model")
            _ensure_model_file(EMBED_MODEL, "embed", "semantic search model")
        except Exception as e:
            print(f"[engine] embed model download failed (semantic search off): {e}", flush=True)
        _phase("starting", meta["label"])
        with _proc_lock:
            _start_chat_locked(meta)
        # Only flip settings once everything is genuinely working.
        db.set_setting("builtin_model", meta["id"])
        db.set_setting("provider", "builtin")
        ensure_embed_running()
        _phase("done")
    except Exception as e:
        _phase("error", str(e)[:400])


_BUSY_PHASES = ("queued", "engine", "model", "embed", "starting")
_BUSY_MSG = "A download is in progress — wait for it to finish first"


def _setup_busy() -> bool:
    return setup_progress()["phase"] in _BUSY_PHASES


def delete_model(model_id: str) -> tuple[bool, str]:
    """Remove a downloaded model. Deleting the ACTIVE one is allowed: its server is
    stopped and the selection cleared, so built-in AI stays off until another is picked."""
    global _chat_proc, _chat_model
    meta = _model_by_id(model_id)
    if meta is None:
        return False, "Unknown model"
    if _setup_busy():
        return False, _BUSY_MSG
    was_active = model_id == active_model()
    with _proc_lock:
        if was_active or _chat_model == model_id:
            _stop(_chat_proc)
            _chat_proc, _chat_model = None, ""
    try:
        model_path(meta).unlink(missing_ok=True)
        model_path(meta).with_name(meta["file"] + ".part").unlink(missing_ok=True)
    except OSError as e:
        return False, f"Couldn't delete the file (is something still using it?): {e}"
    if was_active:
        db.set_setting("builtin_model", "")
    return True, "deleted"


def other_files() -> list[dict]:
    """.gguf/.part files in the models folder that no catalog entry owns: partial
    downloads, and models a catalog update dropped. Listed so they can be cleared."""
    known = {m["file"] for m in CHAT_MODELS()} | {EMBED_MODEL["file"]}
    out = []
    for p in sorted(models_dir().iterdir()):
        if p.is_file() and p.suffix in (".gguf", ".part") and p.name not in known:
            out.append({"name": p.name, "size_mb": p.stat().st_size >> 20, "partial": p.suffix == ".part"})
    return out


def delete_file(name: str) -> tuple[bool, str]:
    if _setup_busy():
        return False, _BUSY_MSG
    # Only names that other_files() itself produced: no path separators, nothing outside the folder.
    if name not in {f["name"] for f in other_files()}:
        return False, "That isn't a removable model file"
    try:
        (models_dir() / name).unlink()
    except OSError as e:
        return False, f"Couldn't delete the file (is something still using it?): {e}"
    return True, "deleted"


# ── Status for the settings UI ───────────────────────────────────────────────

def status() -> dict:
    gpu = detect_gpu()
    active = active_model()
    rec = recommended_id(gpu["vram_mb"])
    with _proc_lock:
        running = _chat_proc is not None and _chat_proc.poll() is None
        loaded = _chat_model
    return {
        "supported": os.name == "nt",
        "engine_installed": server_exe() is not None or engine_zip_path().exists(),
        "gpu": gpu,
        "active_model": active,
        "models": [{
            "id": m["id"],
            "label": m["label"],
            "blurb": m["blurb"],
            "size_mb": m["size"] >> 20,
            "vram_gb": m["vram_gb"],
            "downloaded": _file_ok(m),
            "recommended": m["id"] == rec,
            "active": m["id"] == active,
            "tags": m.get("tags", []),
            # Spec-sheet fields are optional: an older or hand-edited catalog may omit them.
            "family": m.get("family"),
            "params": m.get("params"),
            "arch": m.get("arch"),
            "quant": m.get("quant"),
            "context_k": m.get("context_k"),
            "license": m.get("license"),
            "ram_gb": m.get("ram_gb"),
            "caveats": m.get("caveats") or [],
        } for m in CHAT_MODELS()],
        "other_files": other_files(),
        "embed_downloaded": _file_ok(EMBED_MODEL),
        "setup": setup_progress(),
        "server": {"running": running, "model": loaded},
        "idle_offload_minutes": IDLE_OFFLOAD_S // 60,
        "own_ram_mb": own_ram_mb(),
    }


def own_ram_mb() -> int | None:
    """This process's own working set — what's resident when no model is
    loaded (see _idle_watchdog). Windows only; ctypes, no new dependency."""
    if os.name != "nt":
        return None
    try:
        from ctypes import wintypes

        class _Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                        ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                        ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
        counters = _Counters(cb=ctypes.sizeof(_Counters))
        h = ctypes.windll.kernel32.GetCurrentProcess()
        if ctypes.windll.psapi.GetProcessMemoryInfo(h, ctypes.byref(counters), counters.cb):
            return counters.WorkingSetSize // (1024 * 1024)
    except Exception:
        pass
    return None
