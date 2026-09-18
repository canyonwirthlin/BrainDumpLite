from app import changelog

SAMPLE = """# Changelog

## 0.5.0 — 2026-09-20
- Native Windows app with installer and tray icon.
- Automatic updates with release notes.

## 0.4.3 - 2026-07-20
Built-in AI engine.
"""


def test_parse_splits_versions_and_bodies():
    entries = changelog.parse(SAMPLE)
    assert [e["version"] for e in entries] == ["0.5.0", "0.4.3"]
    assert entries[0]["date"] == "2026-09-20"
    assert entries[0]["body"].startswith("- Native Windows app")
    assert entries[1]["body"] == "Built-in AI engine."


def test_parse_accepts_v_prefix_and_no_date():
    assert changelog.parse("## v1.2.3\nhi")[0] == {"version": "1.2.3", "date": "", "body": "hi"}


def test_section_returns_empty_for_unknown(monkeypatch):
    monkeypatch.setattr(changelog, "load", lambda: changelog.parse(SAMPLE))
    assert changelog.section("0.5.0").startswith("- Native")
    assert changelog.section("9.9.9") == ""


def test_real_changelog_has_current_version():
    from app.version import __version__
    assert changelog.section(__version__), f"CHANGELOG.md needs a '## {__version__}' section"
