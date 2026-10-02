"""Compile content/ into the game: web/game_data.js + web/index.html (local
play) and dist/zeitreisender.html (self-contained page published as the
claude.ai Artifact).

Every piece of player-visible text is pre-analyzed so the runner knows, for
each word, its lemma (for tap-for-help, the notebook, and the "words I
understand" count) without shipping a lemmatizer to the browser.

    python tools/build_game.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from zeit.check import CONTENT, analyze_text, load_config, run  # noqa: E402
from zeit.lexicon import Lexicon  # noqa: E402
from zeit.scenes import load_scenes, validate_links  # noqa: E402

OUT = ROOT / "web" / "game_data.js"


def segments(text: str, lex: Lexicon, day: int, used: dict) -> list:
    """Split text into plain strings and [surface, lemma] pairs."""
    toks = analyze_text(text, lex, day)
    marks = []
    for tk in toks:
        if tk.res.status != "ok":
            continue
        lemma = tk.res.lemma
        used.setdefault(lemma, tk.res)
        marks.append((tk.idx, tk.idx + len(tk.text), lemma))
        if tk.particle_idx >= 0:
            end = tk.particle_idx
            while end < len(text) and text[end].isalpha():
                end += 1
            marks.append((tk.particle_idx, end, lemma))
    marks.sort()
    out, pos = [], 0
    for a, b, lemma in marks:
        if a < pos:
            continue
        if a > pos:
            out.append(text[pos:a])
        out.append([text[a:b], lemma])
        pos = b
    if pos < len(text):
        out.append(text[pos:])
    return out


def figuren() -> dict:
    """content/figuren.txt: '## Name' blocks of character notes for the AI."""
    out, cur = {}, None
    path = ROOT / "content" / "figuren.txt"
    for line in path.read_text(encoding="utf-8").splitlines() if path.exists() else []:
        if line.startswith("## "):
            cur = line[3:].strip()
            out[cur] = ""
        elif cur and line.strip() and not line.startswith("#"):
            out[cur] = (out[cur] + " " + line.strip()).strip()
    return out


FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com">'
         '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
         '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600'
         '&family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,600;1,7..72,400&family=UnifrakturMaguntia&display=swap">')
TITLE = "Moin, Zeitreisender"


def write_pages(data_js: str) -> None:
    web = ROOT / "web"
    body = (web / "body.html").read_text(encoding="utf-8")
    css = (web / "style.css").read_text(encoding="utf-8")
    js = (web / "game.js").read_text(encoding="utf-8")
    # Local version: separate files, open web/index.html directly.
    (web / "index.html").write_text(
        f'<!doctype html>\n<html lang="de">\n<head>\n<meta charset="utf-8">\n'
        f'<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        f"<title>{TITLE}</title>\n{FONTS}\n<link rel=\"stylesheet\" href=\"style.css\">\n</head>\n<body>\n"
        f'{body}<script src="game_data.js"></script>\n<script src="game.js"></script>\n</body>\n</html>\n',
        encoding="utf-8")
    # Artifact version: one self-contained page (the publish step adds the skeleton).
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    (dist / "zeitreisender.html").write_text(
        f"<title>{TITLE}</title>\n{FONTS}\n<style>\n{css}</style>\n{body}"
        f"<script>\n{data_js}</script>\n<script>\n{js}</script>\n", encoding="utf-8")


def word_info(lemma: str, res, lex: Lexicon) -> dict:
    e = lex.entries.get(lemma)
    info = {}
    if e:
        info["k"] = e.kind
        if e.kind == "goethe":
            info["lvl"] = e.level
        if e.hilfe:
            info["h"] = e.hilfe
    if res.how in ("derived", "compound") and res.parts:
        info["teile"] = [p for p in res.parts]
    return info


def main() -> int:
    cfg = load_config()
    lex = Lexicon(cfg["tier_days"], cfg["player"]["assumed_known"])
    scenes = load_scenes(CONTENT)
    errors = validate_links(scenes)
    res = run(scenes, lex, cfg)
    errors += [e for r in res["reports"] for e in r.errors]
    if errors:
        print("Der Checker meldet Fehler. Bitte zuerst `python -m zeit.check` ausführen.")
        for e in errors[:20]:
            print("  ", e)
        return 1

    used: dict = {}
    data = {"order": [], "scenes": {}}
    for sc in scenes:
        nodes = {}
        for name, lines in sc.nodes.items():
            out = []
            for ln in lines:
                item = {"k": ln.kind}
                if ln.kind == "frei":
                    m = ln.meta
                    out.append({"k": "frei", "s": ln.speaker, "thema": ln.text, "to": ln.target,
                                "max": m["max"], "form": m["form"], "lohn": m["lohn"],
                                "ziel": segments(m["ziel"], lex, sc.day, used) if m["ziel"] else None,
                                "braucht": [segments(b, lex, sc.day, used) for b in m["braucht"]],
                                **({"if": ln.cond} if ln.cond else {})})
                    continue
                if ln.text:
                    item["t"] = segments(ln.text, lex, sc.day, used)
                if ln.speaker:
                    item["s"] = ln.speaker
                if ln.target:
                    item["to"] = ln.target
                if ln.cond:
                    item["if"] = ln.cond
                if ln.effects:
                    item["fx"] = ln.effects
                out.append(item)
            nodes[name] = out
        data["order"].append(sc.id)
        data["scenes"][sc.id] = {"tag": sc.day, "titel": sc.meta.get("titel", sc.id),
                                 "ort": sc.meta.get("ort", ""), "nodes": nodes,
                                 "neu": [l for r in res["reports"] if r.scene is sc for l in r.new]}
    data["words"] = {l: word_info(l, r, lex) for l, r in sorted(used.items())}
    data["known_levels"] = sorted(lex.assumed_known)
    data["tier_days"] = {str(k): v for k, v in cfg["tier_days"].items()}
    data["stufe_days"] = {str(k): v for k, v in cfg["stufen"].items()}
    data["start_level"] = cfg["player"]["start_level"]
    data["figuren"] = figuren()
    data["tage"] = {}
    for sc in scenes:
        if sc.tagebuch_formen:
            data["tage"].setdefault(str(sc.day), {})["tagebuch"] = sc.tagebuch_formen
    data_js = ("// generated by tools/build_game.py, do not edit\nwindow.GAME = "
               + json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/") + ";\n")
    OUT.write_text(data_js, encoding="utf-8")
    write_pages(data_js)
    print(f"{OUT.relative_to(ROOT)}: {len(scenes)} Szenen, {len(data['words'])} Wörter")
    return 0


if __name__ == "__main__":
    sys.exit(main())
