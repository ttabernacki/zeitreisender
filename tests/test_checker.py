"""Regression tests for the vocabulary checker. Run: python -m pytest -q"""
import pytest

from zeit.check import analyze_text, load_config
from zeit.lexicon import Lexicon


@pytest.fixture(scope="module")
def lex():
    cfg = load_config()
    return Lexicon(cfg["tier_days"], cfg["player"]["assumed_known"])


def res(lex, text, day=1):
    return {t.text: t.res for t in analyze_text(text, lex, day)}


@pytest.mark.parametrize("sentence,word,lemma", [
    ("Gib mir das Salz!", "Gib", "geben"),
    ("Komm mit!", "Komm", "kommen"),
    ("Leg es hin.", "Leg", "legen"),      # spaCy misses the particle after an imperative
    ("Der Zug kam spät an.", "kam", "ankommen"),
    ("Bodo ruft dich morgen an.", "ruft", "anrufen"),
    ("Hast du Zeit?", "Hast", "haben"),
    ("Wir haben die Säcke getragen.", "getragen", "tragen"),
    ("Er ist größer als ich.", "größer", "groß"),
    ("Er ist größer als ich.", "als", "als"),
    ("Ich muss dich anrufen.", "anrufen", "anrufen"),
    ("Sie wusste es nicht.", "wusste", "wissen"),
    ("Mit den anderen Leuten.", "anderen", "ander"),
])
def test_lemmas(lex, sentence, word, lemma):
    r = res(lex, sentence, day=30)[word]
    assert r.status == "ok" and r.lemma == lemma, r


@pytest.mark.parametrize("sentence,word,parts", [
    ("Das Hafenbüro ist klein.", "Hafenbüro", ("Hafen", "Büro")),
    ("Die Bäckerin lacht.", "Bäckerin", None),
    ("Er ist unfreundlich.", "unfreundlich", ("un", "freundlich")),
    ("Ein kleines Häuschen.", "Häuschen", ("Haus", "-chen")),
])
def test_word_formation(lex, sentence, word, parts):
    r = res(lex, sentence)[word]
    assert r.status == "ok" and r.how in ("derived", "compound"), r
    if parts:
        assert r.parts == parts


@pytest.mark.parametrize("sentence,word,status", [
    ("Die Kerze brennt.", "Kerze", "gesperrt"),         # B1 tier 3, locked on day 1
    ("Der Hund schläft am Kai.", "Kai", "unbekannt"),
    ("Die Fässer sind schwer.", "Fässer", "ausnahme-spaet"),  # declared from day 2
])
def test_flags(lex, sentence, word, status):
    assert res(lex, sentence)[word].status == status


def test_no_false_pass_on_wrong_pos(lex):
    # "Fässer" must never pass as the verb "fassen"
    r = res(lex, "Die Fässer sind schwer.", day=11)["Fässer"]
    assert r.lemma != "fassen"


def test_tiers_unlock(lex):
    assert res(lex, "Der König lacht.", day=1)["König"].status == "ok"      # tier 2: from day 1
    assert res(lex, "Die Kerze brennt.", day=1)["Kerze"].status == "gesperrt"
    assert res(lex, "Die Kerze brennt.", day=11)["Kerze"].status == "ok"   # tier 3: from day 11


def test_grammar_flags(lex):
    toks = {t.text: t.grammar for t in analyze_text("Wenn ich Geld hätte, käme ich. Er brachte Fisch. Du trägst den Sack.", lex, 1)}
    assert "konjunktiv2" in toks["hätte"]
    assert "praeteritum" in toks["brachte"]
    assert toks["trägst"] == []
