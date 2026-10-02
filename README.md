# Moin, Zeitreisender

A text-only German learning game based on comprehensible input. A time traveler is stranded in Hanseatic Hamburg and has to get by using only German. The vocabulary is restricted to the Goethe-Zertifikat word lists and unlocks in tiers. Design brief: `Hanse_Design_Brief.md` (to be added).

## Play

**Artifact (recommended):** https://claude.ai/artifact/9YyZSyrqPbdtb2VrRgdLzy. It's private, so only you can open it. This version has:

- **Typed answers.** Claude works out which story branch you meant, so you can say it your own way, and *Vorschläge zeigen* reveals the hand-written options.
- **Corrections.** The character repeats your sentence correctly in the scene (a recast), and *✎ Korrektur* shows the corrected sentence plus a short German explanation. Nothing you type is restricted by tier: advanced or modern German is never marked wrong for being advanced.
- **Adaptive level.** Each answer gets a CEFR estimate and a list of structures you used correctly. Once you show the level, harder hand-written lines (`(stufe >= 2)`) unlock before their scheduled day, and AI-written lines follow your level.
- **Free conversation.** Scenes can include free talk (`frei:` lines) with a character, at your level.
- **AI word help.** Tap any word and choose *Erklären* for a simple German explanation.
- **Account save.** Your game is saved to your account (private per-user `db` storage). Claude usage runs on your own Claude plan. *Menü* switches the corrections between fast and thorough.

**Local:** open `web/index.html`. It's choices only (no AI) and saves in the browser, with save-file download and upload.

## Setup (for writing content)

```sh
pip install -r requirements.txt
python -m spacy download de_core_news_md
```

## Workflow

```sh
python -m zeit.check            # check all scenes (exit code 1 on errors)
python -m zeit.check -v         # also list accepted compounds/derivations
python -m zeit.check --text "Gib mir das Salz!" --day 1   # check a free sentence
python tools/build_game.py      # compile content/ -> web/ (local) + dist/zeitreisender.html (artifact page); refuses if errors
python -m pytest -q             # checker regression tests
```

Rebuilding the word list (only needed if the parser changes):

```sh
python tools/extract_entries.py   # PDFs -> wordlists/entries_{A1,A2,B1}.txt
python tools/build_lemmas.py      # entries -> vocab/lemmas.tsv
```

## Layout

| Path | What |
|---|---|
| `wordlists/` | Goethe A1/A2/B1 PDFs, extracted raw entries, and the hand-transcribed `wortgruppen.txt` (numbers, days, colors, pronouns) |
| `vocab/lemmas.tsv` | 3,285 lemmas: level, tier, POS, frequency, list-derived forms |
| `vocab/exceptions.tsv` | declared scene nouns, slang, interjections and names, each with a first-allowed day and German word help |
| `vocab/hilfe.tsv` | optional German word help for list words |
| `vocab/config.toml` | tier unlock days, soft budgets, recurrence window, grammar schedule |
| `content/tagNN/*.szene` | scenes (format documented in `zeit/scenes.py`, including `(stufe >= N)` lines and `frei:` free talk) |
| `content/figuren.txt` | character notes the AI uses for in-character replies |
| `zeit/` | scene parser, lexicon/lemmatizer, checker |
| `web/` | runner (`game.js`, `style.css`, `body.html`; generated `index.html`, `game_data.js`) |
| `dist/zeitreisender.html` | generated self-contained page published as the Artifact |

## Tiers

- **Tier 1** (day 1): Goethe A1 + A2. A1 counts as already known, so it never counts toward "new words".
- **Tier 2** (day 11): the more frequent half of the B1-only words (by `wordfreq`).
- **Tier 3** (day 21): the rest of B1.

The tier count (3,285) is higher than the "about 2,000" in the brief. The list prints feminine forms (*Absenderin*), Austrian/Swiss variants, and nouns and verbs as separate headwords, and each of those is its own lemma here.

## What the checker does

- **Lemma resolution:** spaCy lemmas, plus forms taken from the list itself (plurals, principal parts, generated present, imperative and past forms), plus suffix stripping. Separable verbs are re-joined (*kam … an* → *ankommen*). Rule-based guesses must agree with the tagger on noun vs. non-noun, so *Fässer* does not pass as *fassen*.
- **Compounds and derivations:** the Goethe list omits transparent ones, so the checker accepts compounds whose parts are all unlocked (*Hafenbüro* = Hafen + Büro). It also accepts -in, -chen, -ung, -heit/-keit, -er, -lich, -ig, -isch, -los, -bar, un-, particle + verb, and nominalized adjectives and participles. `-v` lists them so you can veto any that are not really transparent.
- **Errors:** unknown words, words from a locked tier, and exceptions used before their declared day. Word-help texts are checked too.
- **Warnings:** known-word share below 90% for a scene; grammar used ahead of schedule (Präteritum before day 11; Konjunktiv II and relative clauses before day 21); declared-new mismatches; daily budget and slang budget exceeded. Budgets are soft.
- **Reports:** new words per scene and day, recurrence (new words not recycled within 3 days or seen fewer than 3 times), and the cumulative vocabulary curve.

Known limitation: spaCy sometimes misses a separable particle after an imperative (*Leg es hin* → *legen*). Both words are allowed, so this only affects new-word counting.

## Publishing changes

After editing content, run `python -m zeit.check` and `python tools/build_game.py`, then republish `dist/zeitreisender.html` to the same artifact URL (capabilities `sample`, `db`, `user`).

## Native review needed

All German text, especially slang (`Digga`, `krass`), interjections, idiom and register, still needs review by a native speaker.
