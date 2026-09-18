"""Live updates. The exe is a thin launcher; the real app code (app/ + static/)
lives in versioned folders under <data>/code/. On every launch this module
checks a manifest URL in the background:

    manifest.json: {"version": "0.3.1", "url": "https://…/update.zip", "sha256": "…"}

A newer version is downloaded, hash-verified, extracted, and atomically placed
at <data>/code/<version>/ — run.py picks the newest healthy version on the NEXT
launch (and falls back to the previous one if a pushed update crashes at boot).

The manifest URL ships as update_url.txt at the bundle root, so it can itself
be changed by an update. Empty/missing file (or no internet) = updater is
silently inert. This module is part of the updatable bundle, so update bugs
can be fixed by an update.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import urllib.request
import zipfile
from pathlib import Path

from . import db
from .version import __version__


def parse_version(v: str) -> tuple:
    nums = re.findall(r"\d+", str(v))
    return tuple(int(x) for x in nums[:3]) if nums else (0,)


def bundle_root() -> Path:
    """Directory holding this running bundle (contains app/, static/, update_url.txt)."""
    return Path(__file__).resolve().parent.parent


def update_url() -> str:
    env = os.environ.get("BRAINDUMP_LITE_UPDATE_URL")
    if env is not None:
        return env.strip()
    f = bundle_root() / "update_url.txt"
    try:
        return f.read_text(encoding="utf-8").strip() if f.exists() else ""
    except OSError:
        return ""


def ready_version() -> str | None:
    """Version of a downloaded-but-not-yet-running update, if any."""
    f = db.data_dir() / "update_ready.txt"
    try:
        if f.exists():
            v = f.read_text(encoding="utf-8").strip()
            if v and parse_version(v) > parse_version(__version__):
                return v
            f.unlink()  # stale marker from an already-applied update
    except OSError:
        pass
    return None


def start_background_check() -> None:
    url = update_url()
    if not url:
        return
    threading.Thread(target=_check, args=(url,), daemon=True).start()


def _check(url: str) -> None:
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            manifest = json.load(r)
        version = str(manifest.get("version", "")).strip()
        zip_url = str(manifest.get("url", "")).strip()
        sha256 = str(manifest.get("sha256", "")).strip().lower()
        if not version or not zip_url:
            return
        if parse_version(version) <= parse_version(__version__):
            return
        code_root = db.data_dir() / "code"
        target = code_root / version
        if target.exists() or (code_root / f"{version}.bad").exists():
            return  # already downloaded, or known-broken — don't loop
        print(f"[updater] downloading update {version}…", flush=True)
        code_root.mkdir(parents=True, exist_ok=True)

        tmp_zip = code_root / f".dl-{version}.bin"
        last_err = None
        for attempt in range(3):  # AV web-shields / flaky Wi-Fi reset transfers
            try:
                with urllib.request.urlopen(zip_url, timeout=120) as r, open(tmp_zip, "wb") as f:
                    shutil.copyfileobj(r, f)
                last_err = None
                break
            except OSError as e:
                last_err = e
        if last_err is not None:
            raise last_err

        if sha256:
            h = hashlib.sha256()
            with open(tmp_zip, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            if h.hexdigest().lower() != sha256:
                raise ValueError("sha256 mismatch — corrupted or tampered download")

        tmp_dir = code_root / f".extract-{version}"
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir)
        with zipfile.ZipFile(tmp_zip) as z:
            for name in z.namelist():  # zip-slip guard
                if name.startswith(("/", "..")) or ".." in Path(name).parts:
                    raise ValueError(f"unsafe path in update zip: {name}")
            z.extractall(tmp_dir)
        if not (tmp_dir / "app" / "__init__.py").exists():
            raise ValueError("update zip missing app/ package")

        tmp_dir.replace(target)
        tmp_zip.unlink(missing_ok=True)
        (db.data_dir() / "update_ready.txt").write_text(version, encoding="utf-8")
        print(f"[updater] update {version} ready — applies on next launch", flush=True)
    except Exception as e:
        print(f"[updater] update check failed (app unaffected): {e}", flush=True)
