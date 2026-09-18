from pathlib import Path

from app import launch


def test_remove_legacy_bundles_deletes_code_dir_and_marker(tmp_path: Path):
    (tmp_path / "code" / "0.4.4" / "app").mkdir(parents=True)
    (tmp_path / "code" / "0.4.4" / "app" / "__init__.py").write_text("")
    (tmp_path / "update_ready.txt").write_text("0.4.4")
    launch.remove_legacy_bundles(tmp_path)
    assert not (tmp_path / "code").exists()
    assert not (tmp_path / "update_ready.txt").exists()


def test_remove_legacy_bundles_is_noop_when_nothing_there(tmp_path: Path):
    launch.remove_legacy_bundles(tmp_path)  # must not raise

import os
import socket
import subprocess
import sys
import threading

import pytest


def test_sidecar_mode_reads_env():
    assert launch.sidecar_mode({"BRAINDUMP_LITE_SIDECAR": "1"}) is True
    assert launch.sidecar_mode({}) is False


def test_pick_port_honours_forced_port():
    assert launch.pick_port({"BRAINDUMP_LITE_PORT": "9123"}) == 9123


def test_pick_port_finds_free_port_in_range():
    p = launch.pick_port({}, start=8756, span=25)
    assert 8756 <= p < 8781
    with socket.socket() as s:
        s.bind(("127.0.0.1", p))  # must still be free


def test_redirect_output_writes_log_and_keeps_previous(tmp_path):
    out, err = sys.stdout, sys.stderr
    try:
        log = launch.redirect_output(tmp_path / "logs")
        print("hello-log")
        sys.stdout.flush()
        assert log == tmp_path / "logs" / "backend.log"
        assert "hello-log" in log.read_text(encoding="utf-8")
        sys.stdout.close()
        launch.redirect_output(tmp_path / "logs")
        assert "hello-log" in (tmp_path / "logs" / "backend.log.1").read_text(encoding="utf-8")
        sys.stdout.close()
    finally:
        sys.stdout, sys.stderr = out, err


@pytest.mark.skipif(os.name != "nt", reason="parent watchdog is Windows-only in v1")
def test_watch_parent_fires_when_process_exits():
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    fired = threading.Event()
    try:
        t = launch.watch_parent(child.pid, on_exit=fired.set)
        assert t is not None and not fired.is_set()
        child.kill()
        assert fired.wait(5), "watchdog did not notice parent death"
    finally:
        child.kill()
