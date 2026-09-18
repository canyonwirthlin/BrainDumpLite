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
