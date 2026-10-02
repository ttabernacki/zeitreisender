"""Vocabulary checker: python -m zeit.check [--text "..." --day N] [--json out.json]

Reads every scene under content/, lemmatizes it (spaCy + list-derived forms
+ rules), and reports per scene and per day:
  * errors:   unknown words, words from a locked tier, exceptions used too early
  * new words (first appearance; A1 is assumed known) vs. the daily budget
  * share of running words the player already knows (i+1 target)
  * grammar used ahead of schedule (Präteritum, Konjunktiv II, Relativsätze)
  * recurrence: new words not recycled within the window
  * the vocabulary curve across days
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from .lexicon import PARTICLES, ROOT, Lexicon, Resolution
from .scenes import Scene, SceneError, load_scenes, validate_links

CONTENT = ROOT / "content"
SEIN_HABEN_MODAL = {"sein", "haben", "werden", "können", "müssen", "dürfen", "sollen", "wollen", "mögen"}
TOKEN_RE = re.compile(r"[A-Za-zÄÖÜäöüß]+(?:-[A-Za-zÄÖÜäöüß]+)*(?:'s)?")


def load_config() -> dict:
    with (ROOT / "vocab" / "config.toml").open("rb") as f:
        cfg = tomllib.load(f)
    cfg["tier_days"] = {int(k): v for k, v in cfg["tiers"].items()}
    cfg["stufen"] = {int(k): v for k, v in cfg["stufen"].items()}
    return cfg


@lru_cache(maxsize=1)
def nlp():
    import spacy
    return spacy.load("de_core_news_md")


@dataclass
class Tok:
    text: str
    res: Resolution
    lineno: int
    grammar: list = field(default_factory=list)
    idx: int = 0             # character offset in the analyzed text
    particle_idx: int = -1   # offset of a detached separable particle ("an" in "kam ... an")


def analyze_text(text: str, lex: Lexicon, day: int, lineno: int = 0) -> list[Tok]:
    doc = nlp()(text)
    particles = {}                       # verb token index -> particle
    for t in doc:
        if (t.tag_ == "PTKVZ" and t.head.i != t.i and t.head.pos_ in ("VERB", "AUX")
                and t.text.lower() in PARTICLES):
            particles[t.head.i] = t
    out = []
    for t in doc:
        if not TOKEN_RE.fullmatch(t.text):
            continue
        if t.tag_ == "PTKVZ" and t.head.i in particles and particles[t.head.i] is t:
            continue                     # counted with its verb
        hints = [t.lemma_]
        if t.i in particles:
            p = particles[t.i].text.lower()
            hints = [p + t.lemma_, p + t.text.lower()] + hints
        noun = True if t.tag_ == "NN" else False if t.i > 0 and t.text[:1].islower() else None
        res = lex.resolve(t.text, day, hints, noun)
        if t.i in particles and res.status == "ok" and res.lemma == t.lemma_:
            # "legt ... hin" with "hinlegen" not on the list: base verb + particle
            res = Resolution("ok", particles[t.i].text.lower() + res.lemma, "derived",
                             (particles[t.i].text.lower(), res.lemma))
        g = []
        if (t.morph.get("Mood") == ["Sub"] and t.pos_ in ("VERB", "AUX") and t.lemma_ != "mögen"
                and res.status == "ok" and lex.entries[res.lemma].pos == "VERB"
                # spaCy over-reports Sub on present forms like "trägst": Konjunktiv II
                # forms end in -e/-est/-en/-et (käme, hättest, würden, wärt)
                and re.search(r"(e|est|en|et|t)$", t.text.lower())
                and t.text.lower() not in lex.present_forms(res.lemma)
                and (not t.text.lower().endswith("st") or t.text.lower().endswith("est"))):
            g.append("konjunktiv2")
        if (t.morph.get("Tense") == ["Past"] and t.tag_.endswith("FIN")
                and t.morph.get("Mood") != ["Sub"] and t.lemma_ not in SEIN_HABEN_MODAL
                and res.lemma not in SEIN_HABEN_MODAL
                and t.text.lower() not in lex.present_forms(res.lemma)):
            g.append("praeteritum")
        if t.tag_ in ("PRELS", "PRELAT"):
            g.append("relativsatz")
        out.append(Tok(t.text, res, lineno, g, t.idx, particles[t.i].idx if t.i in particles else -1))
    return out


@dataclass
class SceneReport:
    scene: Scene
    tokens: list
    new: list = field(default_factory=list)
    errors: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    info: list = field(default_factory=list)
    known_share: float = 1.0


def run(scenes: list[Scene], lex: Lexicon, cfg: dict) -> dict:
    first_seen: dict[str, tuple[int, str]] = {}
    exposures: dict[str, Counter] = defaultdict(Counter)   # lemma -> day -> count
    reports: list[SceneReport] = []
    is_name = {l for l, e in lex.entries.items() if e.kind in ("name", "interjektion")}

    for sc in scenes:
        day = sc.day
        toks = []
        bonus_toks = []
        for lineno, text, cond in sc.texts():
            m = re.search(r"stufe\s*>=?\s*(\d)", cond or "")
            if m:
                # level-gated line: checked at that tier, not counted as new
                tday = max(day, cfg["stufen"].get(int(m.group(1)), day))
                bonus_toks += analyze_text(text, lex, tday, lineno)
            else:
                toks += analyze_text(text, lex, day, lineno)
        rep = SceneReport(sc, toks)
        known = 0
        counted = 0
        for tk in toks:
            r = tk.res
            if r.status == "unbekannt":
                rep.errors.append(f"Z.{tk.lineno}: unbekannt: {tk.text}")
                continue
            if r.status == "gesperrt":
                e = lex.entries[r.lemma]
                rep.errors.append(f"Z.{tk.lineno}: {tk.text} ({r.lemma}) gehört zur Wortschatzstufe {e.tier}, frei ab Tag {cfg['tier_days'][e.tier]}")
                continue
            if r.status == "ausnahme-spaet":
                rep.errors.append(f"Z.{tk.lineno}: {tk.text} ({r.lemma}) ist erst ab Tag {lex.entries[r.lemma].day} deklariert")
                continue
            if r.how in ("derived", "compound"):
                rep.info.append(f"{tk.text} = {' + '.join(r.parts)}")
            lemma = r.lemma
            if lemma in is_name:
                continue
            counted += 1
            if lex.is_assumed_known(lemma) or lemma in first_seen:
                known += 1
            else:
                first_seen[lemma] = (day, sc.id)
                rep.new.append(lemma)
            exposures[lemma][day] += 1
        rep.known_share = known / counted if counted else 1.0
        for tk in bonus_toks:
            if tk.res.status != "ok":
                rep.errors.append(f"Z.{tk.lineno} (Bonus): {tk.text} → {tk.res.status}")
        for g in sorted({g for tk in toks for g in tk.grammar}):
            if day < cfg["grammar"][g]:
                ex = next(tk.text for tk in toks if g in tk.grammar)
                rep.warnings.append(f"Grammatik '{g}' vor Tag {cfg['grammar'][g]} (z. B. '{ex}')")
        declared = set(sc.declared_new)
        if declared:
            missing = [w for w in declared if w not in rep.new]
            undeclared = [w for w in rep.new if w not in declared]
            if missing:
                rep.warnings.append("als neu deklariert, aber nicht neu/benutzt: " + ", ".join(missing))
            if undeclared:
                rep.info.append("neu, aber nicht deklariert: " + ", ".join(undeclared))
        for e in lex.entries.values():
            if e.kind != "goethe" and e.lemma in rep.new and not e.hilfe:
                rep.warnings.append(f"keine Worthilfe für Ausnahme '{e.lemma}' (vocab/exceptions.tsv)")
        if rep.known_share < cfg["comprehension"]["target_known_share"]:
            rep.warnings.append(f"nur {rep.known_share:.0%} bekannte Wörter (Ziel {cfg['comprehension']['target_known_share']:.0%})")
        reports.append(rep)

    # ---- word help must itself be comprehensible on the day it can first be shown
    hilfe_errors = []
    for e in lex.entries.values():
        if not e.hilfe:
            continue
        d = e.day if e.kind != "goethe" else cfg["tier_days"].get(e.tier, 1)
        for tk in analyze_text(e.hilfe, lex, d):
            if tk.res.status != "ok" and tk.text.lower() != e.lemma.lower():
                hilfe_errors.append(f"Worthilfe '{e.lemma}' (Tag {d}): {tk.text} → {tk.res.status}")

    # ---- per day
    days = sorted({s.day for s in scenes})
    per_day = {}
    for d in days:
        new = [l for r in reports if r.scene.day == d for l in r.new]
        slang = [l for l in new if l in lex.entries and lex.entries[l].kind == "slang"]
        per_day[d] = {"new": new, "slang": slang}

    # ---- recurrence
    win, need = cfg["recurrence"]["window_days"], cfg["recurrence"]["min_exposures"]
    last_day = max(days) if days else 0
    recurrence = []
    for lemma, (d0, sid) in first_seen.items():
        if d0 + win > last_day:
            continue                     # window not written yet
        seen = sum(c for d, c in exposures[lemma].items() if d0 <= d <= d0 + win)
        later = sorted(d for d in exposures[lemma] if d0 < d <= d0 + win)
        if seen < need or not later:
            recurrence.append((lemma, d0, sid, seen, later))

    curve = []
    total = 0
    for d in days:
        total += len(per_day[d]["new"])
        curve.append((d, len(per_day[d]["new"]), total))
    return {"hilfe_errors": hilfe_errors, "reports": reports, "per_day": per_day, "recurrence": recurrence,
            "curve": curve, "exposures": exposures, "first_seen": first_seen}


def print_report(res: dict, cfg: dict, lex: Lexicon, verbose: bool) -> int:
    n_err = 0
    budget, slang_budget = cfg["budget"]["new_words_per_day"], cfg["budget"]["slang_per_day"]
    for rep in res["reports"]:
        sc = rep.scene
        print(f"\n── Tag {sc.day} · {sc.id} ({sc.path.relative_to(ROOT)})")
        print(f"   bekannt: {rep.known_share:.0%}   neu ({len(rep.new)}): {', '.join(rep.new) or '–'}")
        for e in rep.errors:
            print(f"   FEHLER  {e}")
        for w in rep.warnings:
            print(f"   WARNUNG {w}")
        if verbose:
            for i in dict.fromkeys(rep.info):
                print(f"   info    {i}")
        n_err += len(rep.errors)
    if res["hilfe_errors"]:
        print("\n══ Worthilfe")
        for e in res["hilfe_errors"]:
            print(f"   FEHLER  {e}")
        n_err += len(res["hilfe_errors"])
    print("\n══ Tage")
    for d, v in res["per_day"].items():
        flag = "  (über Budget)" if len(v["new"]) > budget else ""
        sflag = "  (Slang über Budget)" if len(v["slang"]) > slang_budget else ""
        print(f"   Tag {d:2}: {len(v['new']):3} neue Wörter / Budget {budget}{flag};"
              f" Slang {len(v['slang'])}/{slang_budget}{sflag}")
    print(f"\n══ Wiederholung (Fenster {cfg['recurrence']['window_days']} Tage,"
          f" mind. {cfg['recurrence']['min_exposures']}×)")
    if not res["recurrence"]:
        print("   alles gut (oder Fenster noch nicht geschrieben)")
    for lemma, d0, sid, seen, later in sorted(res["recurrence"], key=lambda x: (x[1], x[0])):
        print(f"   {lemma:20} neu Tag {d0} ({sid}), {seen}× im Fenster, danach an Tagen: {later or '–'}")
    print("\n══ Wortschatzkurve (neue Wörter, kumuliert)")
    for d, n, total in res["curve"]:
        print(f"   Tag {d:2} {n:3} {total:5}  " + "▇" * (total // 10))
    print(f"\n{n_err} Fehler.")
    return n_err


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--text", help="check a free text instead of the scenes")
    ap.add_argument("--day", type=int, default=1, help="day for --text (default 1)")
    ap.add_argument("--json", help="also write the report as JSON")
    ap.add_argument("-v", "--verbose", action="store_true", help="show compounds/derivations")
    args = ap.parse_args(argv)
    cfg = load_config()
    lex = Lexicon(cfg["tier_days"], cfg["player"]["assumed_known"])

    if args.text:
        bad = 0
        for tk in analyze_text(args.text, lex, args.day):
            r = tk.res
            extra = f" = {' + '.join(r.parts)}" if r.parts else ""
            mark = "  " if r.status == "ok" else "!!"
            bad += r.status != "ok"
            print(f"{mark} {tk.text:18} {r.status:14} {r.lemma}{extra}  [{r.how}]"
                  + (f"  {tk.grammar}" if tk.grammar else ""))
        return 1 if bad else 0

    try:
        scenes = load_scenes(CONTENT)
    except SceneError as e:
        print(f"FEHLER {e}")
        return 1
    link_errors = validate_links(scenes)
    for e in link_errors:
        print(f"FEHLER {e}")
    res = run(scenes, lex, cfg)
    n_err = print_report(res, cfg, lex, args.verbose) + len(link_errors)
    if args.json:
        Path(args.json).write_text(json.dumps({
            "curve": res["curve"],
            "per_day": res["per_day"],
            "recurrence": res["recurrence"],
            "scenes": [{"id": r.scene.id, "day": r.scene.day, "new": r.new, "errors": r.errors,
                        "warnings": r.warnings, "known_share": r.known_share} for r in res["reports"]],
        }, ensure_ascii=False, indent=1), encoding="utf-8")
    return 1 if n_err else 0


if __name__ == "__main__":
    sys.exit(main())
