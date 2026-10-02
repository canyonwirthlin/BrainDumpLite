"""Capture screen: prompt on/off + no-repeat bookkeeping, template list, quick-capture page wiring."""
import random
import re
from pathlib import Path

import pytest

from app import db, prompts

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(autouse=True)
def _vault():
    db.init_db()
    db.execute("DELETE FROM settings WHERE key IN ('journal_prompts_seen','journal_prompt_enabled')")


def test_prompt_enabled_defaults_on_and_follows_setting():
    assert prompts.enabled() is True
    db.set_setting("journal_prompt_enabled", False)
    assert prompts.enabled() is False
    db.set_setting("journal_prompt_enabled", True)
    assert prompts.enabled() is True


def test_next_prompt_records_seen_and_skips_them():
    rng = random.Random(7)
    first = prompts.next_prompt(rng)
    assert first["id"] in db.get_setting("journal_prompts_seen", [])
    # Everything but one bank entry already seen: the remaining one must come back.
    ids = [f"b{i}" for i in range(len(prompts.BANK))]
    keep = ids[-1]
    db.set_setting("journal_prompts_seen", ids[:-1])
    assert prompts.next_prompt(rng)["id"] == keep


def test_seen_list_is_capped():
    rng = random.Random(3)
    for _ in range(prompts.KEEP_SEEN + 20):
        prompts.next_prompt(rng)
    assert len(db.get_setting("journal_prompts_seen", [])) <= prompts.KEEP_SEEN


def test_templates_defined():
    src = (ROOT / "static/js/templates.js").read_text(encoding="utf-8")
    ids = re.findall(r'id: "(\w+)"', src)
    assert ids == ["morning", "shutdown", "meeting", "worry"]


def test_quick_capture_page_posts_a_dump():
    html = (ROOT / "static/quick.html").read_text(encoding="utf-8")
    assert '"/api/dumps"' in html and "bdlQuick" in html
    rs = (ROOT / "src-tauri/src/quick.rs").read_text(encoding="utf-8")
    assert "Modifiers::CONTROL | Modifiers::SHIFT" in rs and "Code::Space" in rs
