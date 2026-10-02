"""Extract raw headword entries from the Goethe A1/A2/B1 Wortlisten (PDF).

The PDFs are laid out in columns: a headword column (word, article, plural,
principal parts) next to an example-sentence column. pdftotext-style
extraction interleaves them, so we read word boxes and keep only those whose
x-position falls inside a headword band. Lines are then merged into entries
(a verb's principal parts wrap over several lines).

Output: wordlists/entries_<LEVEL>.txt, one raw entry per line.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pdfplumber

ROOT = Path(__file__).resolve().parent.parent
WL = ROOT / "wordlists"

# level -> (pdf, page range of the alphabetical list, headword bands [x_min, x_max))
LAYOUT = {
    "A1": ("Goethe-Zertifikat_A1_Wortliste.pdf", range(8, 27), [(138, 232)]),
    "A2": ("Goethe-Zertifikat_A2_Wortliste.pdf", range(7, 31), [(30, 103), (299, 372)]),
    "B1": ("Goethe-Zertifikat_B1_Wortliste.pdf", range(15, 102), [(30, 130), (310, 409)]),
}

TOP, BOTTOM = 60, 790  # skip running headers/footers


def band_lines(page, x0, x1):
    words = [
        w for w in page.extract_words(keep_blank_chars=False, use_text_flow=False)
        if x0 <= w["x0"] < x1 and TOP < w["top"] < BOTTOM
    ]
    words.sort(key=lambda w: (round(w["top"]), w["x0"]))
    lines: list[list[dict]] = []
    for w in words:
        if lines and abs(lines[-1][0]["top"] - w["top"]) < 2.5:
            lines[-1].append(w)
        else:
            lines.append([w])
    out = []
    for ln in lines:
        ln.sort(key=lambda w: w["x0"])
        out.append((ln[0]["top"], ln[0]["x0"], " ".join(w["text"] for w in ln)))
    return out


SECTION_LETTER = re.compile(r"^[A-ZÄÖÜ]$")


def is_continuation(prev: str, cur: str, indent: bool) -> bool:
    # "Haupt-", "eigen-": a bare prefix is a headword of its own
    if prev.endswith("-") and " " not in prev:
        return False
    if prev.endswith((",", "-", "/", "→")) and not prev.endswith(", -"):
        return True
    if re.match(r"^(hat|ist|hat/ist)\b", cur):
        return True
    # verb entry wrapped mid-way: "sich anstrengen, strengt" / "sich an, ..., hat sich angestrengt"
    verb_open = re.match(r"^(sich )?[a-zäöü]+(en|ern|eln|n), ", prev) and not re.search(r"\b(hat|ist)\s", prev)
    if verb_open and (re.search(r"\b(hat|ist)\s", cur) or re.match(r"^(sich )?[a-zäöü]+[ ,]", cur) and "," in cur):
        return True
    if cur.startswith(("→", "(")) and not cur.startswith("(sich)"):
        return True
    return indent and not re.match(r"^(der|die|das)\b", cur)


def extract(level: str) -> list[str]:
    pdf_name, pages, bands = LAYOUT[level]
    entries: list[str] = []
    with pdfplumber.open(WL / pdf_name) as pdf:
        for i in pages:
            page = pdf.pages[i]
            for x0, x1 in bands:
                prev_top = None
                for top, left, text in band_lines(page, x0, x1):
                    text = text.strip()
                    if not text or SECTION_LETTER.match(text):
                        prev_top = None
                        continue
                    # Indented lines (relative to the band start) are wraps,
                    # except articles, which are indented in A1.
                    indent = left - x0 > 22
                    gap_small = prev_top is not None and top - prev_top < 12
                    if entries and gap_small and is_continuation(entries[-1], text, indent):
                        if entries[-1].endswith("-") and text[:1].islower():
                            entries[-1] = entries[-1][:-1] + text  # hyphenated line break
                        else:
                            entries[-1] = entries[-1] + " " + text
                    else:
                        entries.append(text)
                    prev_top = top
    return entries


def main(argv: list[str]) -> None:
    for level in argv or LAYOUT:
        entries = extract(level)
        (WL / f"entries_{level}.txt").write_text("\n".join(entries) + "\n", encoding="utf-8")
        print(level, len(entries), "entries")


if __name__ == "__main__":
    main(sys.argv[1:])
