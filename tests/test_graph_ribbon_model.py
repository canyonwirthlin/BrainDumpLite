"""Brain map ribbon: the pure logic in static/js/graph/ribbon-model.js, run for real under Node (no DOM needed)."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

GRAPH = Path(__file__).resolve().parent.parent / "static" / "js" / "graph"
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")


def run_model(body: str):
    script = f'import * as M from "{(GRAPH / "ribbon-model.js").as_uri()}";\n{body}\n'
    out = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


def test_first_sentence_makes_a_one_sentence_tooltip():
    r = run_model("""console.log(JSON.stringify([
      M.firstSentence("Hides the dumps. Bigger dots are mentioned more."),
      M.firstSentence("Force-directed clusters: nodes that share topics pull together."),
      M.firstSentence("  Lots   of\\n space.  Second. "),
      M.firstSentence(""), M.firstSentence(null),
      M.firstSentence("x".repeat(300) + " tail words here", 40),
    ]))""")
    assert r[0] == "Hides the dumps."
    assert r[1] == "Force-directed clusters: nodes that share topics pull together."
    assert r[2] == "Lots of space."
    assert r[3] == "" and r[4] == ""
    assert len(r[5]) <= 40 and r[5].endswith("…")


def test_pick_tab_only_accepts_a_known_tab():
    r = run_model("""const tabs=[{id:"view"},{id:"layout"}];
      console.log(JSON.stringify([M.pickTab("layout",tabs), M.pickTab("nope",tabs), M.pickTab(null,tabs), M.pickTab("x",[])]))""")
    assert r == ["layout", "view", "view", ""]


def test_row_gets_a_divider_wherever_the_group_changes():
    r = run_model("""const t=(id,g)=>({id,group:g});
      const row=M.buildRow([t("a","x"),t("b","x"),t("c","y"),t("d",undefined),t("e","")]);
      console.log(JSON.stringify(row.map(e=>e.type==="divider"?"|":e.tool.id)))""")
    # undefined and "" are the same (ungrouped) group, so there is no divider between d and e
    assert r == ["a", "b", "|", "c", "|", "d", "e"]


def test_tab_signature_changes_when_a_tool_is_added():
    r = run_model("""console.log(JSON.stringify([M.tabSignature([{id:"a"},{id:"b"}]), M.tabSignature([{id:"a"},{id:"b"},{id:"c"}]), M.tabSignature([])]))""")
    assert r[0] != r[1] and r[2] == "" and r[0] == "a|b"


def test_help_model_lists_every_tool_with_a_name_and_plain_help():
    r = run_model("""const m=M.helpModel({label:"Edit",help:"Change your map."},[
        {id:"select",label:"Select",help:"Click a note.",key:"S"},
        {id:"x",label:()=>"Dynamic",tip:"Only a tip."},
        {id:"y",tip:"Icon only tool."}]);
      console.log(JSON.stringify(m))""")
    assert r["title"] == "Edit tab" and r["intro"] == "Change your map."
    assert [i["name"] for i in r["items"]] == ["Select", "Dynamic", "Icon only tool."]
    assert [i["help"] for i in r["items"]] == ["Click a note.", "Only a tip.", "Icon only tool."]
    assert r["items"][0]["key"] == "S"


def test_tooltip_stays_inside_the_window_and_flips_above_when_there_is_no_room():
    r = run_model("""const view={w:1000,h:700}, size={w:200,h:40};
      console.log(JSON.stringify([
        M.placeTip({left:400,top:100,bottom:150,width:50}, size, view),   // centred below
        M.placeTip({left:0,top:100,bottom:150,width:20}, size, view),     // clamped to the left margin
        M.placeTip({left:980,top:100,bottom:150,width:20}, size, view),   // clamped to the right margin
        M.placeTip({left:400,top:660,bottom:690,width:50}, size, view),   // no room below: above
      ]))""")
    assert r[0] == {"left": 325, "top": 158, "side": "below"}
    assert r[1]["left"] == 8 and r[1]["side"] == "below"
    assert r[2]["left"] == 1000 - 200 - 8
    assert r[3]["side"] == "above" and r[3]["top"] == 660 - 8 - 40


def test_arrow_keys_move_between_tabs_and_wrap():
    r = run_model("""console.log(JSON.stringify([
        M.nextTabIndex("ArrowRight",0,6), M.nextTabIndex("ArrowRight",5,6), M.nextTabIndex("ArrowLeft",0,6),
        M.nextTabIndex("Home",3,6), M.nextTabIndex("End",3,6), M.nextTabIndex("a",3,6), M.nextTabIndex("ArrowRight",0,0)]))""")
    assert r == [1, 0, 5, 0, 5, -1, -1]
