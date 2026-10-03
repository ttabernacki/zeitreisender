"""Parser for the scene format (content/dayNN/*.szene).

    ---
    tag: 1
    szene: hafen
    titel: Am Hafen
    ort: Hafen
    neu: Hafen, Kiste, tragen
    ---

    == start
    Du öffnest die Augen. Wasser, Schiffe, Leute.
    Bodo: Moin! Du da!
    notiz: Moin!
    * Moin! -> moin
    * (bodo >= 2) Wer, ich? -> wer {geld +1, bodo +1}
    -> weiter

Line types inside a node:
    == name                  start of a node
    Name: text               dialogue (Name must be a declared character)
    * text -> node {fx}      reply choice; optional (condition) and {effects}
    -> node                  jump (also: -> ENDE ends the scene)
    notiz: text              add a phrase to the player's notebook
    frei: Name | Thema | 6 -> node | ziel: ... | braucht: a; b | form: perfekt, weil | lohn: greta +1
                             free conversation / task with a character
                             (AI-driven in the artifact), up to 6 player turns,
                             then -> node. Thema is a note to the AI (not
                             shown). The optional parts make it a task:
                               ziel:    German goal shown to the player (checked)
                               braucht: things the player must tell/ask,
                                        separated by ";" (German, shown as a
                                        checklist and checked)
                               form:    grammar constructions the player must
                                        use correctly (see FORMEN)
                               lohn:    effects applied when everything is done
    // comment               ignored
    anything else            narration

Narration, dialogue and notiz lines may start with a condition, like
choices: "(stufe >= 2) Hinnerk: ..." shows the line only when the player's
demonstrated level has reached tier 2. Such lines are checked against that
tier's vocabulary and are not counted as new words of the day.

Conditions may combine with "&&": "(rabatt && geld >= 1)". "(ki)" is true only
where the AI features are available, "(!ki)" only without them: use it to give
the plain local version a fallback for a task.

Scene metadata may also carry  tagebuch: perfekt, weil  on the last scene of a
day: the diary prompt at the end of that day asks for those constructions.

Effects: "geld +2", "bodo -1", "item Salz", "flag tuer_offen".
Targets may name another scene: "-> markt" or "-> markt.start".
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

SPEAKER = re.compile(r"^([A-ZÄÖÜ][\wÄÖÜäöüß]*(?: [A-ZÄÖÜ][\wÄÖÜäöüß]*)?):\s+(.*)$")
CHOICE = re.compile(r"^\*\s*(?:\((?P<cond>[^)]*)\)\s*)?(?P<text>.*?)\s*->\s*(?P<target>[\w.]+)\s*(?:\{(?P<fx>[^}]*)\})?\s*$")
JUMP = re.compile(r"^->\s*(?P<target>[\w.]+)\s*(?:\{(?P<fx>[^}]*)\})?\s*$")
NODE = re.compile(r"^==\s*(\w+)\s*$")
COND = re.compile(r"^\((?P<cond>[^)]*)\)\s*(?P<rest>.*)$")
FREI = re.compile(r"^frei:\s*(?P<who>[^|]+?)\s*\|\s*(?P<thema>[^|]+?)\s*\|\s*(?P<n>\d+)\s*->\s*(?P<target>[\w.]+)\s*(?P<opts>(?:\|.*)?)$")

# Grammar constructions a task or the diary may require. The AI reports the
# same keys when it lists what the player used correctly.
FORMEN = ("perfekt", "praeteritum", "modalverb", "imperativ", "nebensatz", "weil", "dass", "wenn",
          "reflexiv", "vergleich", "konjunktiv2", "relativsatz", "passiv", "zu_infinitiv",
          "negation", "dativ", "akkusativ", "praeposition", "frage")


@dataclass
class Line:
    kind: str            # narration | dialogue | choice | jump | notiz
    text: str = ""
    speaker: str = ""
    target: str = ""
    cond: str = ""
    effects: list = field(default_factory=list)
    lineno: int = 0
    meta: dict = field(default_factory=dict)     # frei: max, ziel, braucht, form, lohn


@dataclass
class Scene:
    path: Path
    meta: dict
    nodes: dict          # name -> list[Line]

    @property
    def day(self) -> int:
        return int(self.meta.get("tag", 0))

    @property
    def id(self) -> str:
        return self.meta.get("szene", self.path.stem)

    @property
    def declared_new(self) -> list[str]:
        return [w.strip() for w in self.meta.get("neu", "").split(",") if w.strip()]

    @property
    def tagebuch_formen(self) -> list[str]:
        return [w.strip() for w in self.meta.get("tagebuch", "").split(",") if w.strip()]

    def texts(self):
        """Yield (lineno, text, cond) for every piece of German the player reads."""
        for lines in self.nodes.values():
            for ln in lines:
                if ln.kind == "frei":
                    if ln.meta.get("ziel"):
                        yield ln.lineno, ln.meta["ziel"], ln.cond
                    for item in ln.meta.get("braucht", []):
                        yield ln.lineno, item, ln.cond
                elif ln.text:
                    yield ln.lineno, ln.text, ln.cond


def parse_effects(fx: str | None) -> list:
    out = []
    for part in (fx or "").split(","):
        part = part.strip()
        if not part:
            continue
        key, _, val = part.partition(" ")
        out.append([key, val.strip()])
    return out


class SceneError(Exception):
    pass


def parse_frei_opts(opts: str, where: str) -> dict:
    meta = {"ziel": "", "braucht": [], "form": [], "lohn": []}
    for part in opts.split("|"):
        part = part.strip()
        if not part:
            continue
        key, _, val = part.partition(":")
        key, val = key.strip().lower(), val.strip()
        if key == "ziel":
            meta["ziel"] = val
        elif key == "braucht":
            meta["braucht"] = [x.strip() for x in val.split(";") if x.strip()]
        elif key == "form":
            meta["form"] = [x.strip() for x in val.split(",") if x.strip()]
            bad = [f for f in meta["form"] if f not in FORMEN]
            if bad:
                raise SceneError(f"{where}: unbekannte Form {bad} (erlaubt: {', '.join(FORMEN)})")
        elif key == "lohn":
            meta["lohn"] = parse_effects(val)
        else:
            raise SceneError(f"{where}: unbekannte Option '{key}' bei frei:")
    return meta


def parse_scene(path: Path) -> Scene:
    raw = path.read_text(encoding="utf-8").splitlines()
    meta: dict = {}
    i = 0
    if raw and raw[0].strip() == "---":
        i = 1
        while i < len(raw) and raw[i].strip() != "---":
            k, _, v = raw[i].partition(":")
            meta[k.strip()] = v.strip()
            i += 1
        i += 1
    nodes: dict = {}
    cur = None
    for n in range(i, len(raw)):
        s = raw[n].strip()
        lineno = n + 1
        if not s or s.startswith("//"):
            continue
        if m := NODE.match(s):
            cur = m.group(1)
            if cur in nodes:
                raise SceneError(f"{path}:{lineno}: Knoten '{cur}' doppelt")
            nodes[cur] = []
            continue
        if cur is None:
            raise SceneError(f"{path}:{lineno}: Text vor dem ersten '== knoten'")
        cond = ""
        if not s.startswith("*") and (mc := COND.match(s)):
            cond, s = mc["cond"].strip(), mc["rest"].strip()
        if m := FREI.match(s):
            ln = Line("frei", m["thema"], speaker=m["who"], target=m["target"],
                      meta={"max": int(m["n"]), **parse_frei_opts(m["opts"], f"{path}:{lineno}")})
        elif m := CHOICE.match(s):
            ln = Line("choice", m["text"], target=m["target"], cond=(m["cond"] or "").strip(),
                      effects=parse_effects(m["fx"]))
        elif m := JUMP.match(s):
            ln = Line("jump", target=m["target"], effects=parse_effects(m["fx"]))
        elif s.lower().startswith("notiz:"):
            ln = Line("notiz", s.split(":", 1)[1].strip())
        elif m := SPEAKER.match(s):
            ln = Line("dialogue", m.group(2), speaker=m.group(1))
        else:
            ln = Line("narration", s)
        ln.lineno = lineno
        if cond:
            ln.cond = cond
        nodes[cur].append(ln)
    if "start" not in nodes:
        raise SceneError(f"{path}: kein Knoten '== start'")
    bad = [f for f in [w.strip() for w in meta.get("tagebuch", "").split(",") if w.strip()] if f not in FORMEN]
    if bad:
        raise SceneError(f"{path}: unbekannte Tagebuch-Form {bad}")
    return Scene(path, meta, nodes)


def load_scenes(content_dir: Path) -> list[Scene]:
    scenes = [parse_scene(p) for p in sorted(content_dir.glob("**/*.szene"))]
    scenes.sort(key=lambda s: (s.day, int(s.meta.get("reihenfolge", 0)), s.path.name))
    return scenes


def validate_links(scenes: list[Scene]) -> list[str]:
    """Return error strings for jumps/choices pointing at missing nodes."""
    errors = []
    by_id = {s.id: s for s in scenes}
    for s in scenes:
        for node, lines in s.nodes.items():
            for ln in lines:
                if ln.kind not in ("choice", "jump", "frei") or ln.target == "ENDE":
                    continue
                scene_id, _, tnode = ln.target.partition(".")
                if ln.target in s.nodes:
                    continue
                if scene_id in by_id and (not tnode or tnode in by_id[scene_id].nodes):
                    continue
                errors.append(f"{s.path.name}:{ln.lineno}: Ziel '{ln.target}' nicht gefunden")
    return errors
