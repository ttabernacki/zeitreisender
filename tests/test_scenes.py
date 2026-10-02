"""Scene format tests. Run: python -m pytest -q"""
import textwrap

import pytest

from zeit.scenes import SceneError, parse_scene


def scene(tmp_path, body, meta="tag: 1\nszene: t"):
    p = tmp_path / "t.szene"
    p.write_text(f"---\n{meta}\n---\n" + textwrap.dedent(body), encoding="utf-8")
    return parse_scene(p)


def test_task_line(tmp_path):
    s = scene(tmp_path, """
        == start
        frei: Greta | note for the AI | 4 -> ende | ziel: Bitte Greta um Brot. | braucht: was du willst; wie viele | form: weil, perfekt | lohn: flag rabatt, greta +1
        == ende
        -> ENDE
    """)
    ln = s.nodes["start"][0]
    assert ln.kind == "frei" and ln.speaker == "Greta" and ln.target == "ende"
    assert ln.meta["max"] == 4
    assert ln.meta["braucht"] == ["was du willst", "wie viele"]
    assert ln.meta["form"] == ["weil", "perfekt"]
    assert ln.meta["lohn"] == [["flag", "rabatt"], ["greta", "+1"]]
    # goal and checklist items are player-visible text, the AI note is not
    shown = [t for _, t, _ in s.texts()]
    assert shown == ["Bitte Greta um Brot.", "was du willst", "wie viele"]


def test_plain_free_talk_still_parses(tmp_path):
    s = scene(tmp_path, """
        == start
        frei: Alheit | Am Feuer. | 5 -> ENDE
    """)
    ln = s.nodes["start"][0]
    assert ln.meta["braucht"] == [] and ln.meta["form"] == [] and ln.meta["ziel"] == ""
    assert list(s.texts()) == []


def test_unknown_form_is_an_error(tmp_path):
    with pytest.raises(SceneError):
        scene(tmp_path, "== start\nfrei: A | b | 3 -> ENDE | form: gibtsnicht\n")


def test_unknown_task_option_is_an_error(tmp_path):
    with pytest.raises(SceneError):
        scene(tmp_path, "== start\nfrei: A | b | 3 -> ENDE | bonus: 5\n")


def test_diary_meta(tmp_path):
    s = scene(tmp_path, "== start\n-> ENDE\n", meta="tag: 1\nszene: t\ntagebuch: perfekt, weil")
    assert s.tagebuch_formen == ["perfekt", "weil"]
    with pytest.raises(SceneError):
        scene(tmp_path, "== start\n-> ENDE\n", meta="tag: 1\nszene: t\ntagebuch: unfug")


def test_conditional_lines_and_choices(tmp_path):
    s = scene(tmp_path, """
        == start
        (ki) frei: A | note | 2 -> ENDE
        (!ki) Greta: Hallo.
        * (!rabatt && geld >= 2) Ein Brot, bitte. -> ENDE {geld -2}
    """)
    frei, line, choice = s.nodes["start"]
    assert frei.cond == "ki" and line.cond == "!ki"
    assert choice.cond == "!rabatt && geld >= 2"
