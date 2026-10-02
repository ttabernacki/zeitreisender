"""Build the tiered lemma list from the extracted Goethe entries.

Input:  wordlists/entries_{A1,A2,B1}.txt  (from extract_entries.py)
        wordlists/wortgruppen.txt          (hand-transcribed thematic groups)
Output: vocab/lemmas.tsv

Columns: lemma, level (A1/A2/B1 = lowest list it appears on), tier (1-3),
pos (NOUN/VERB/OTHER), zipf (wordfreq), forms (comma-separated inflected
forms taken from the list itself: plurals, principal parts).

Tier 1 = A1 + A2. B1-only words are split by corpus frequency: the more
frequent half -> tier 2, the rest -> tier 3.
"""
from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path

from wordfreq import zipf_frequency

ROOT = Path(__file__).resolve().parent.parent
WL = ROOT / "wordlists"
OUT = ROOT / "vocab" / "lemmas.tsv"

LEVELS = ["A1", "A2", "B1"]
ARTICLES = {"der", "die", "das", "der/die", "die/der", "der/das", "das/der"}
UMLAUT = {"a": "ä", "o": "ö", "u": "ü", "A": "Ä", "O": "Ö", "U": "Ü"}
AUX = {"hat", "ist", "hat/ist", "ist/hat"}
JUNK = {"alphabetischer", "wortschatz", "wortliste"}

# Spots where the PDF text layer lost spaces.
FIXES = {"sicherkälten": "sich erkälten", "erkältetsich": "erkältet sich"}
# Fragments of labels/abbreviations, not words.
FORM_STOP = {"sich", "es", "an", "vor", "am", "als", "zusammen", "Modalverb", "lassen"}
STOP = {"A", "CH", "D", "pl", "Pl", "Sg", "en", "un", "o", "ca", "usw", "etc", "bzw", "Ergeschoß"}

WORD = re.compile(r"^[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß\-]*$")


def umlaut_last(stem: str) -> str:
    """Apply umlaut to the last umlautable vowel (au -> äu)."""
    m = re.search(r"(au|Au|[aouAOU])(?=[^aouäöüAOUÄÖÜ]*$)", stem)
    if not m:
        return stem
    s = m.group(1)
    rep = "äu" if s == "au" else "Äu" if s == "Au" else UMLAUT[s]
    return stem[: m.start()] + rep + stem[m.end():]


def plural_forms(noun: str, spec: str) -> list[str]:
    spec = spec.replace(" ", "").replace("“", "¨").replace('"', "¨")
    forms = []
    for part in spec.split("/"):
        if not part or part in {"-", "–"}:
            continue
        uml = "¨" in part or re.search(r"[ÄÖÜäöü]", part) is not None
        suffix = re.sub(r"[^a-zß]", "", part.replace("Ä", "").replace("Ö", "").replace("Ü", "")
                        .replace("ä", "").replace("ö", "").replace("ü", ""))
        base = umlaut_last(noun) if uml else noun
        forms.append(base + suffix)
    if spec in {"¨-", "-¨"}:
        forms.append(umlaut_last(noun))
    return forms


def plural_spec(rest: str) -> str:
    """'-Ä, e' (A1 style) -> '¨-e'; otherwise the first comma field."""
    rest = rest.split(";")[0]
    m = re.match(r"\s*-\s*[ÄÖÜäöü¨]\s*,\s*([a-z]+)", rest)
    if m:
        return "¨-" + m.group(1)
    return rest.split(",")[0]


def clean(entry: str) -> str:
    e = entry.replace("­", "").replace("’", "'")
    for a, b in FIXES.items():
        e = e.replace(a, b)
    e = re.sub(r"(?<=[a-zäöüß])(?=[A-ZÄÖÜ][a-zäöü])", " ", e)  # "BargeldIch" -> "Bargeld Ich"
    e = re.sub(r",(?=\S)", ", ", e)
    e = re.sub(r"^sich ", "", e)
    e = re.split(r"→|\bA:|\bD:|\bCH:|=", e)[0]          # drop regional cross-refs
    e = re.sub(r"\((sich|Sg\.|Pl\.|D|A|CH|D, A|D, CH|A, CH|[a-zäöü/ ]+)\)", " ", e)
    e = re.sub(r"\(([^)]*)\)", r"\1", e)                  # Ankunft(-szeit) etc.
    e = re.sub(r"\d+\.?$", "", e.strip())                 # glued example numbers
    e = e.replace("!", "").replace("?", "").replace("…", "").replace("...", "")
    return re.sub(r"\s+", " ", e).strip(" ,;")


def parse(entry: str):
    """Yield (lemma, pos, forms) tuples for one raw entry."""
    e = clean(entry)
    if not e:
        return
    toks = e.split(" ")
    if toks[0].lower() in JUNK or toks[0].isdigit():
        return
    if toks[0] in ARTICLES and len(toks) > 1:
        head, _, rest = " ".join(toks[1:]).partition(",")
        head = head.strip()
        for noun in (h.strip().split(" ")[0] for h in head.split("/")):
            noun = noun.strip("-")
            if WORD.match(noun) and noun[:1].isupper():
                yield noun, "NOUN", plural_forms(noun, plural_spec(rest)) if rest else []
        return
    if "," in e and re.match(r"^[a-zäöü]", e):
        parts = [p.strip() for p in e.split(",")]
        inf = parts[0].split(" ")[0]
        if (inf.endswith("en") or (inf.endswith(("ern", "eln")) and len(inf) > 5)
             or inf in ("sein", "tun")) and WORD.match(inf) and len(parts) >= 2 and (
            any(p.split(" ")[0] in AUX for p in parts[1:]) or len(parts) >= 3
        ):
            forms = []
            for p in parts[1:]:
                ws = [w for w in p.split(" ") if w and w not in AUX and WORD.match(w)]
                forms.extend(w for w in ws if not (len(ws) > 1 and w == ws[-1] and len(w) <= 6
                                                   and inf.startswith(w)))
            yield inf, "VERB", forms
            return
    # Adjectives, adverbs, function words, multi-word headwords ("als ob", "an sein")
    for part in re.split(r"[,/ ]", e):
        part = part.strip("-.")
        if WORD.match(part) and len(part) > 0:
            pos = "NOUN" if part[:1].isupper() else "OTHER"
            yield part, pos, []


def main() -> None:
    level_of: dict[str, str] = {}
    pos_of: dict[str, str] = {}
    forms_of: dict[str, set] = defaultdict(set)

    def add(lemma, pos, forms, level):
        if len(lemma) < 2 or lemma in STOP:
            return
        m = re.match(r"^([A-Za-zÄÖÜäöüß]{3,})-([A-Za-zÄÖÜäöüß]{3,})$", lemma)
        if m:  # line-wrap hyphen inside a compound: "Back-Ofen" -> "Backofen"
            lemma = m.group(1) + m.group(2).lower()
        if lemma not in level_of or LEVELS.index(level) < LEVELS.index(level_of[lemma]):
            level_of[lemma] = level
        if pos_of.get(lemma) != "VERB":
            pos_of[lemma] = pos
        forms_of[lemma].update(f for f in forms if f != lemma)

    for level in LEVELS:
        for line in (WL / f"entries_{level}.txt").read_text(encoding="utf-8").splitlines():
            for lemma, pos, forms in parse(line):
                add(lemma, pos, forms, level)
    for line in (WL / "wortgruppen.txt").read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        level, entry = line.split("\t", 1)
        for lemma, pos, forms in parse(entry):
            add(lemma, pos, forms, level)

    # Drop junk that leaked into form lists: reflexive "sich", labels, particles,
    # and other words that are lemmas in their own right (except participle-
    # or finite-looking leftovers such as "nimmt", which are OTHER lemmas).
    for l in level_of:
        forms_of[l] = {f for f in forms_of[l]
                       if f not in FORM_STOP and (f[:1].islower() or pos_of[l] == "NOUN")
                       and not (f in level_of and pos_of[f] != "OTHER")}

    # Inflected verb forms that leaked out as their own "lemmas" (an entry whose
    # principal parts wrapped badly) fold back into the verb.
    verb_level: dict[str, int] = {}
    for v, p in pos_of.items():
        if p == "VERB" and v in level_of:
            for f in forms_of[v]:
                verb_level[f] = min(verb_level.get(f, 9), LEVELS.index(level_of[v]))
    for l in [l for l in level_of if pos_of[l] == "OTHER" and l in verb_level]:
        if verb_level[l] <= LEVELS.index(level_of[l]):
            del level_of[l]

    zipf = {l: zipf_frequency(l, "de") for l in level_of}
    b1_only = sorted((l for l in level_of if level_of[l] == "B1"), key=lambda l: -zipf[l])
    cut = len(b1_only) // 2
    tier = {l: 1 for l in level_of if level_of[l] in ("A1", "A2")}
    tier.update({l: 2 for l in b1_only[:cut]})
    tier.update({l: 3 for l in b1_only[cut:]})

    OUT.parent.mkdir(exist_ok=True)
    with OUT.open("w", encoding="utf-8") as f:
        f.write("lemma\tlevel\ttier\tpos\tzipf\tforms\n")
        for l in sorted(level_of, key=lambda s: (s.lower(), s)):
            f.write(f"{l}\t{level_of[l]}\t{tier[l]}\t{pos_of[l]}\t{zipf[l]:.2f}\t"
                    f"{','.join(sorted(forms_of[l]))}\n")
    counts = defaultdict(int)
    for t in tier.values():
        counts[t] += 1
    print(f"{len(level_of)} lemmas -> {OUT.relative_to(ROOT)}; per tier: {dict(sorted(counts.items()))}")


if __name__ == "__main__":
    main()
