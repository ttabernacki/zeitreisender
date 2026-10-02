"""Allowed vocabulary: Goethe lemmas (tiered), declared exceptions, and the
rules that map an inflected/derived/compound word form back to them."""
from __future__ import annotations

import csv
import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VOCAB = ROOT / "vocab"

PARTICLES = sorted("""ab an auf aus bei dabei dafür dagegen daher dahin daneben
dar davon dazu durch ein empor entgegen entlang fern fest fort her herab heran
herauf heraus herbei herein herum herunter hervor hin hinab hinauf hinaus hinein
hinter hinunter hinüber los mit nach nieder rauf raus rein rüber runter statt
teil um unter vor voran voraus vorbei vorher vorüber weg weiter wieder zu
zurecht zurück zusammen über""".split(), key=len, reverse=True)
INSEP_PREFIXES = ["be", "emp", "ent", "er", "ge", "miss", "ver", "zer"]
UMLAUT_BACK = str.maketrans({"ä": "a", "ö": "o", "ü": "u", "Ä": "A", "Ö": "O", "Ü": "U"})

# Fixed function-word forms the suffix rules would not find.
FUNCTION_FORMS = {
    "den": "der", "dem": "der", "des": "der", "das": "der", "die": "der",
    "deren": "der", "dessen": "der", "denen": "der",
    "einen": "ein", "einem": "ein", "einer": "ein", "eines": "ein", "eine": "ein",
    "alle": "all", "allem": "all", "allen": "all", "aller": "all", "alles": "all",
    "andere": "ander", "anderen": "ander", "anderem": "ander", "anderer": "ander", "anderes": "ander",
    "Ihnen": "ihnen", "Ihr": "ihr", "Ihre": "ihr", "Sie": "sie",
    "ihre": "ihr", "ihren": "ihr", "ihrem": "ihr", "ihrer": "ihr", "ihres": "ihr",
    "unsere": "unser", "unseren": "unser", "unserem": "unser", "unserer": "unser", "unsres": "unser",
    "eure": "euer", "euren": "euer", "eurem": "euer", "eurer": "euer",
    "mehr": "viel", "meisten": "viel", "lieber": "gern", "am": "an", "im": "in",
    "ins": "in", "zum": "zu", "zur": "zu", "beim": "bei", "vom": "von", "ans": "an",
    "aufs": "auf", "fürs": "für", "ums": "um", "besser": "gut", "beste": "gut",
    "besten": "gut", "bester": "gut", "bestes": "gut", "höher": "hoch", "nächste": "nah",
    "hohe": "hoch", "hohen": "hoch", "hohem": "hoch", "hoher": "hoch", "hohes": "hoch",
    "gibt's": "geben", "geht's": "gehen", "wie's": "wie",
}

# Irregular finite forms not derivable from the principal parts.
IRREGULAR = {
    "haben": "hab habe hast hat habt hätte hättest hätten hättet",
    "sein": "bin bist ist sind seid sei seien wär wäre wärst wären wärt",
    "werden": "werde wirst wird werdet würde würdest würden würdet",
    "wissen": "weiß weißt wisst wusste wusstest wussten wüsste",
    "können": "kann kannst könnt könnte könntest könnten",
    "dürfen": "darf darfst dürft dürfte dürftest dürften",
    "müssen": "muss musst müsst müsste müsstest müssten",
    "sollen": "soll sollst sollt",
    "wollen": "will willst wollt",
    "mögen": "mag magst mögt möchte möchtest möchten möchtet",
    "tun": "tu tue tust tut tat tätest",
}

STRIP_SUFFIXES = ["ern", "nen", "test", "tet", "ten", "est", "ste", "sten", "ster", "stes",
                  "te", "en", "em", "er", "es", "et", "st", "e", "n", "s", "t"]
LINKERS = ["", "s", "es", "n", "en", "e", "er", "ens"]


@dataclass
class Entry:
    lemma: str
    level: str
    tier: int
    pos: str
    kind: str = "goethe"     # goethe | szene | slang | name
    day: int = 1             # for exceptions: day it may first appear
    hilfe: str = ""


@dataclass
class Resolution:
    status: str              # ok | neu-erlaubt? see Lexicon.resolve
    lemma: str
    how: str = ""            # direct | form | rule | compound | derived | exception
    parts: tuple = ()


def _verb_stem(inf: str) -> str:
    if inf.endswith(("eln", "ern")):
        return inf[:-1]
    if inf.endswith("en"):
        return inf[:-2]
    return inf[:-1]


class Lexicon:
    def __init__(self, tier_days: dict[int, int], assumed_known: list[str]):
        self.tier_days = tier_days
        self.assumed_known = set(assumed_known)
        self.entries: dict[str, Entry] = {}
        self.lower: dict[str, list[str]] = defaultdict(list)
        self.forms: dict[str, set[str]] = defaultdict(set)
        self._load_goethe()
        self._load_exceptions()
        self._load_hilfe()
        for lemma in self.entries:
            self.lower[lemma.lower()].append(lemma)
        for lemma, forms in IRREGULAR.items():
            if lemma in self.entries:
                for fm in forms.split():
                    self.forms[fm].add(lemma)

    # ---------------------------------------------------------------- loading
    def _load_goethe(self) -> None:
        with (VOCAB / "lemmas.tsv").open(encoding="utf-8") as f:
            rows = list(csv.DictReader(f, delimiter="\t"))
        for r in rows:
            self.entries[r["lemma"]] = Entry(r["lemma"], r["level"], int(r["tier"]), r["pos"])
        for r in rows:
            lemma, forms = r["lemma"], [x for x in r["forms"].split(",") if x]
            if r["pos"] == "VERB":
                self._index_verb(lemma, forms)
            else:
                for fm in forms:
                    self.forms[fm].add(lemma)

    def _index_verb(self, lemma: str, forms: list[str]) -> None:
        base = None
        for p in PARTICLES:
            rest = lemma[len(p):]
            if lemma.startswith(p) and rest in self.entries and self.entries[rest].pos == "VERB":
                base = rest
                break
        stem = _verb_stem(lemma)
        generated = {stem, stem + "e", stem + "st", stem + "t", stem + "et", stem + "est", stem + "en"}
        for fm in forms:
            generated.add(fm)
            if fm.endswith("t") and not fm.startswith("ge"):        # gibt -> gib, gibst
                generated |= {fm[:-1], fm[:-1] + "st", fm[:-1] + "est"}
            if fm.endswith("te"):                                   # machte -> machten
                generated |= {fm + "n", fm + "st", fm + "t"}
            elif not fm.endswith(("t", "en")):                      # gab -> gaben, gabst
                generated |= {fm + "en", fm + "st", fm + "t", fm + "est"}
        for fm in generated:
            # Forms of a separable verb without its particle belong to the base verb
            # when that exists ("gibt" -> geben, not abgeben).
            target = base if base and not fm.startswith(lemma[: len(lemma) - len(base)]) else lemma
            self.forms[fm].add(target)

    def _load_exceptions(self) -> None:
        path = VOCAB / "exceptions.tsv"
        if not path.exists():
            return
        with path.open(encoding="utf-8") as f:
            for r in csv.DictReader((l for l in f if not l.startswith("#")), delimiter="\t"):
                lemma = r["wort"].strip()
                e = Entry(lemma, "-", 0, "NOUN" if lemma[:1].isupper() else "OTHER",
                          kind=r["art"].strip(), day=int(r.get("ab_tag") or 1),
                          hilfe=(r.get("hilfe") or "").strip())
                self.entries[lemma] = e
                for fm in (r.get("formen") or "").split(","):
                    if fm.strip():
                        self.forms[fm.strip()].add(lemma)

    def _load_hilfe(self) -> None:
        path = VOCAB / "hilfe.tsv"
        if not path.exists():
            return
        with path.open(encoding="utf-8") as f:
            for r in csv.DictReader((l for l in f if not l.startswith("#")), delimiter="\t"):
                if r["wort"] in self.entries and r.get("hilfe"):
                    self.entries[r["wort"]].hilfe = r["hilfe"].strip()

    # -------------------------------------------------------------- queries
    def present_forms(self, lemma: str) -> set[str]:
        stem = _verb_stem(lemma)
        return {stem, stem + "e", stem + "st", stem + "est", stem + "t", stem + "et", stem + "en"}

    def unlocked(self, lemma: str, day: int) -> bool:
        e = self.entries[lemma]
        if e.kind != "goethe":
            return e.day <= day
        return self.tier_days.get(e.tier, 999) <= day

    def is_assumed_known(self, lemma: str) -> bool:
        e = self.entries.get(lemma)
        return bool(e and e.kind == "goethe" and e.level in self.assumed_known)

    def lookup(self, word: str) -> list[str]:
        """Exact lemma or listed form (case-insensitive fallback)."""
        out = []
        for w in (word, word.lower(), word[:1].upper() + word[1:].lower()):
            if w in self.entries:
                out.append(w)
            out.extend(sorted(self.forms.get(w, ())))
        if not out:
            out.extend(self.lower.get(word.lower(), []))
        if word in FUNCTION_FORMS:
            out.append(FUNCTION_FORMS[word])
        elif word.lower() in FUNCTION_FORMS:
            out.append(FUNCTION_FORMS[word.lower()])
        return list(dict.fromkeys(o for o in out if o in self.entries))

    def strip_candidates(self, word: str) -> list[str]:
        """Inflection-stripping guesses: Kisten -> Kiste, größer -> groß, gemacht -> machen."""
        cands = []
        variants = {word, word.lower(), word.translate(UMLAUT_BACK), word.lower().translate(UMLAUT_BACK)}
        for w in variants:
            for suf in STRIP_SUFFIXES:
                if w.endswith(suf) and len(w) - len(suf) >= 2:
                    stem = w[: -len(suf)]
                    cands += [stem, stem + "e", stem + "en", stem + "n"]
            # participles: gemacht, abgeholt, gegangen, aufgestanden
            m = re.match(r"^(" + "|".join(PARTICLES) + r")?ge(.+?)(t|et|en)$", w)
            if m:
                cands += [(m.group(1) or "") + m.group(2) + "en", (m.group(1) or "") + m.group(2) + "n"]
            m = re.match(r"^(" + "|".join(PARTICLES) + r")zu(.+)$", w)       # anzurufen
            if m:
                cands.append(m.group(1) + m.group(2))
        out = []
        for c in cands:
            out += self.lookup(c)
        return list(dict.fromkeys(out))

    # ------------------------------------------------------ word formation
    # Closed-class words never count as compound or derivation pieces.
    CLOSED = set("""der ein kein mein dein sein ihr unser euer dies jed welch all ander
    ich du er sie es wir man sich mich dich mir dir ihn ihm uns euch ihnen""".split())
    NOUN_ENDINGS = ["", "n", "en", "s", "es", "e", "er", "ern", "nen"]

    def _content(self, lemma: str, day: int) -> bool:
        return lemma not in self.CLOSED and len(lemma) >= 3 and self.unlocked(lemma, day)

    def _head(self, w: str, day: int, noun: bool) -> str | None:
        """Last piece of a compound: a listed word (+ plural/case ending)."""
        for end in self.NOUN_ENDINGS:
            if end and not w.endswith(end):
                continue
            base = w[: len(w) - len(end)] if end else w
            for c in self.lookup(base):
                if self._content(c, day) and (self.entries[c].pos == "NOUN") == noun:
                    return c
        return None

    def _first_piece(self, w: str, day: int) -> str | None:
        """Non-final piece: a listed word, or a verb stem ("Schreib-tisch")."""
        for c in self.lookup(w) + self.lookup(w + "en") + self.lookup(w + "n") + self.lookup(w + "e"):
            if self._content(c, day):
                return c
        return None

    def _pieces(self, w: str, day: int, noun: bool, depth: int = 0) -> list[str] | None:
        if depth:
            h = self._head(w, day, noun)
            if h:
                return [h]
        if depth > 2:
            return None
        for i in range(len(w) - 3, 2, -1):
            head, tail = w[:i], w[i:]
            for link in LINKERS:
                if link and not head.endswith(link):
                    continue
                left = head[: len(head) - len(link)] if link else head
                lp = self._first_piece(left, day) if len(left) >= 3 else None
                if lp:
                    rest = self._pieces(tail, day, noun, depth + 1)
                    if rest:
                        return [lp] + rest
        return None

    def compound(self, word: str, day: int) -> Resolution | None:
        if len(word) < 6:
            return None
        noun = word[:1].isupper()
        parts = self._pieces(word.lower(), day, noun)
        if parts and len(parts) >= 2:
            return Resolution("ok", word, "compound", tuple(parts))
        return None

    # (suffix, endings tried on the stem to find the base)
    NOUN_SUFFIXES = [("innen", [""]), ("in", [""]), ("chen", ["", "e"]), ("lein", ["", "e"]),
                     ("ung", ["en", "n"]), ("heit", [""]), ("keit", ["", "ig"]),
                     ("erei", ["en", "n"]), ("er", ["en", "n"])]
    ADJ_SUFFIXES = [("lich", ["", "en", "e"]), ("ig", ["", "e"]), ("isch", ["", "e"]),
                    ("los", ["", "e"]), ("bar", ["en", "n"]), ("end", ["en", "n"])]
    INFL = ["", "e", "en", "em", "er", "es", "n", "s"]

    def _simple(self, w: str, day: int, pos: set | None = None) -> str | None:
        for c in self.lookup(w) + self.strip_candidates(w):
            if self._content(c, day) and (pos is None or self.entries[c].pos in pos):
                return c
        return None

    def derive(self, word: str, day: int) -> Resolution | None:
        noun = word[:1].isupper()
        w = word.lower()
        if noun:
            # nominalized adjective/participle: der Reisende, das Gute
            for end in self.INFL:
                if end and not w.endswith(end):
                    continue
                stem = w[: len(w) - len(end)] if end else w
                base = self._simple(stem, day, {"OTHER"})
                if base and len(stem) >= 3:
                    return Resolution("ok", word, "derived", (base, "nominalisiert"))
                r = self._suffix(stem, day, self.ADJ_SUFFIXES, {"VERB", "NOUN", "OTHER"})
                if r and r[1] == "-end":
                    return Resolution("ok", word, "derived", r)
            for end in ["", "nen", "n", "en", "s"]:
                if end and not w.endswith(end):
                    continue
                stem = w[: len(w) - len(end)] if end else w
                r = self._suffix(stem, day, self.NOUN_SUFFIXES, {"VERB", "NOUN", "OTHER"})
                if r:
                    return Resolution("ok", word, "derived", r)
            if w.startswith("un"):
                base = self._simple(word[2:].capitalize(), day, {"NOUN"})
                if base:
                    return Resolution("ok", word, "derived", ("un", base))
            return None
        for end in self.INFL:
            if end and not w.endswith(end):
                continue
            stem = w[: len(w) - len(end)] if end else w
            if stem.startswith("un") and len(stem) > 5:
                base = self._simple(stem[2:], day, {"OTHER"})
                if base:
                    return Resolution("ok", word, "derived", ("un", base))
            r = self._suffix(stem, day, self.ADJ_SUFFIXES, {"VERB", "NOUN", "OTHER"})
            if r:
                return Resolution("ok", word, "derived", r)
        # particle + verb: mitkommen, hinlegen, rausgehen
        for pre in PARTICLES:
            if w.startswith(pre) and len(w) - len(pre) >= 3:
                base = self._simple(w[len(pre):], day, {"VERB"})
                if base:
                    return Resolution("ok", word, "derived", (pre, base))
        return None

    def _suffix(self, stem: str, day: int, table, pos: set):
        for suf, reps in table:
            if not stem.endswith(suf) or len(stem) - len(suf) < 3:
                continue
            core = stem[: -len(suf)]
            for st in dict.fromkeys([core, core.translate(UMLAUT_BACK)]):
                for rep in reps:
                    for cand in (st + rep, (st + rep).capitalize()):
                        base = self._simple(cand, day, pos)
                        if base:
                            return (base, "-" + suf)
        return None

    # ------------------------------------------------------------ resolve
    def resolve(self, word: str, day: int, hints: list[str] = (), noun: bool | None = None) -> Resolution:
        """Map a surface word to an allowed lemma for `day`.

        status: ok | gesperrt (on the list, tier not yet unlocked)
                | ausnahme-spaet (declared exception used before its day) | unbekannt
        """
        cands = list(dict.fromkeys(
            [h for h in hints if h in self.entries] + self.lookup(word)
            + [l for h in hints for l in self.lookup(h)]))
        stripped = self.strip_candidates(word)
        if noun is not None:
            # Guessed lemmas must agree with the tagger on noun vs. non-noun
            # ("Fässer" must not pass as the verb "fassen").
            stripped = [c for c in stripped if (self.entries[c].pos == "NOUN") == noun]
        for c in cands:
            if self.unlocked(c, day):
                return Resolution("ok", c, "direct")
        for c in stripped:
            if self.unlocked(c, day):
                return Resolution("ok", c, "rule")
        r = self.derive(word, day) or self.compound(word, day)
        if r and (noun is None or r.lemma[:1].isupper() == noun or word[:1].isupper() == noun):
            return r
        locked = cands + stripped
        if locked:
            c = locked[0]
            e = self.entries[c]
            return Resolution("ausnahme-spaet" if e.kind != "goethe" else "gesperrt", c, "direct")
        return Resolution("unbekannt", word)
