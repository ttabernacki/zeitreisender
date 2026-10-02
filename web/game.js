// Moin, Zeitreisender – runner. All player-facing text is German.
// Works in two places: as a claude.ai Artifact (AI corrections, tasks, diary,
// save in your account) and as a plain local file (choices only, browser save).
(function () {
  "use strict";
  const G = window.GAME;
  const KEY = "zeitreisender.v2";
  const $ = (s) => document.querySelector(s);
  const ART = { szene: "Hamburger Wort", slang: "Umgangssprache", name: "Name", interjektion: "Ausruf" };
  const UNCOUNTED = new Set(["name", "interjektion"]);
  const CEFR = ["A1", "A2", "A2+", "B1-", "B1", "B1+", "B2"];
  const START = G.start_level || "A2";
  // The player starts at A2: Goethe A1 and A2 vocabulary is known; the new words are B1 words.
  const STUFE_TEXT = {
    1: "A2: Präsens, Perfekt (haben/sein), Modalverben, Imperativ, Komparativ, reflexive Verben, Nebensätze mit weil/dass, einfache Präpositionen mit Dativ/Akkusativ; ganze Sätze von normaler Länge; Wortschatz Goethe A1/A2 und einzelne häufige B1-Wörter, die man aus dem Zusammenhang versteht.",
    2: "A2+ bis B1-: zusätzlich Präteritum in Erzählungen, Nebensätze mit wenn/als/obwohl, einfache Relativsätze, Passiv in einfachen Sätzen; längere Sätze; Wörter bis Goethe B1, häufige zuerst.",
    3: "B1: zusätzlich Konjunktiv II für höfliche Bitten und Wünsche (könnte, hätte, würde), Relativsätze, damit/um … zu; längere zusammenhängende Dialoge.",
  };
  // Grammar constructions a task or the diary can require: [label, example frame].
  const FORM = {
    perfekt: ["Perfekt", "Ich habe … gemacht. / Ich bin … gegangen."],
    praeteritum: ["Präteritum", "Er war … / Sie hatte … / Ich ging …"],
    modalverb: ["Modalverb", "Ich muss / kann / will … + Verb."],
    imperativ: ["Imperativ", "Komm mit! Gib mir …!"],
    nebensatz: ["Nebensatz", "…, weil / dass / wenn … (Verb am Ende)."],
    weil: ["weil-Satz", "…, weil ich … habe. (Verb am Ende)"],
    dass: ["dass-Satz", "Ich glaube, dass … (Verb am Ende)."],
    wenn: ["wenn-Satz", "Wenn ich …, dann …"],
    reflexiv: ["reflexives Verb", "Ich freue mich. / Ich wasche mich."],
    vergleich: ["Vergleich", "größer als … / so … wie …"],
    konjunktiv2: ["Konjunktiv II", "Ich hätte gern … / Könntest du …?"],
    relativsatz: ["Relativsatz", "…, der / die / das … (Verb am Ende)."],
    passiv: ["Passiv", "Das Brot wird gebacken."],
    zu_infinitiv: ["um … zu", "Ich gehe …, um … zu …"],
    negation: ["Verneinung", "kein … / nicht …"],
    dativ: ["Dativ", "mit dem …, bei der …, ich gebe dir …"],
    akkusativ: ["Akkusativ", "Ich sehe den …, ich habe einen …"],
    praeposition: ["Präposition", "in, auf, mit, zu … + richtiger Fall"],
  };
  // Mistake categories the AI sorts errors into (label shown on the Fehler page).
  const KAT = {
    haben_sein: "haben oder sein (Perfekt)", partizip: "Partizip II (getragen, gemacht)",
    artikel: "Artikel und Genus", akkusativ: "Akkusativ", dativ: "Dativ",
    wortstellung: "Wortstellung (Verb an Position 2)", verb_ende: "Verb am Ende (Nebensatz)",
    konjugation: "Verbform (ich gehe, du gehst)", plural: "Plural", praeposition: "Präposition",
    reflexiv: "reflexive Verben", negation: "Verneinung (nicht / kein)", modal: "Modalverb + Infinitiv",
    adjektiv: "Adjektivendung", wortwahl: "Wortwahl", rechtschreibung: "Rechtschreibung",
    sprache: "Englisch statt Deutsch", sonst: "Sonstiges",
  };
  const KEINE_SCHWAECHE = ["sonst", "rechtschreibung", "sprache", "wortwahl"];
  const RUECKFRAGEN = ["Hm? Wie bitte?", "Wie meinst du das?", "Das habe ich nicht ganz verstanden. Noch einmal?"];

  let S = null;           // game state
  let SAMPLE = null;      // claude "sample" capability, null when unavailable
  let DOC = null;         // db document for this player's save, null when unavailable
  let busy = null;        // AbortController of the running AI call
  let vorschlaegeOffen = false, vollOffen = false, resetArmed = false;
  let entwurf = "";       // text to put into the input box on the next redraw
  let panelTab = "saetze";

  // ------------------------------------------------------------- state
  function neuesProfil() {
    return { niveau: [], strukturen: {}, eigene: {}, stufe: 1, runden: 0, korrekt: 0, selbst: 0,
             fehler: {}, nachgeschlagen: [] };
  }
  function neuesSpiel() {
    return { v: 2, szene: G.order[0], knoten: "start", tag: G.scenes[G.order[0]].tag, geld: 0,
             rel: {}, items: [], flags: [], notiz: [], seen: {}, log: [], warten: null,
             profil: neuesProfil(), tagebuch: {}, einst: { tier: "quick" }, tipp: false };
  }
  function tagStufe() {
    let st = 1;
    for (const [t, d] of Object.entries(G.stufe_days || G.tier_days)) if (S.tag >= d) st = Math.max(st, Number(t));
    return st;
  }
  function stufe() { return Math.max(tagStufe(), S.profil.stufe || 1); }

  // ------------------------------------------------------------- save
  let saveTimer = null, saveChain = Promise.resolve();
  function speichern() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
    if (!DOC) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const snap = JSON.parse(JSON.stringify(S));
      saveChain = saveChain.then(() => DOC.set({ stand: snap })).catch(() => {});
    }, 800);
  }
  function lokalLaden() {
    try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function gueltig(st) { return st && st.v === 2 && st.szene && G.scenes[st.szene]; }

  // Download/upload of a save file: only offered in the local version.
  function exportieren() {
    const blob = new Blob([JSON.stringify(S, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "zeitreisender-spielstand-tag" + S.tag + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function importieren(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const st = JSON.parse(r.result);
        if (!gueltig(st)) throw new Error();
        start(st); speichern(); schliessen();
      } catch (e) { hinweis("Diese Datei ist kein Spielstand."); }
    };
    r.readAsText(file);
  }

  // ------------------------------------------------------------- rules
  function wert(name) {
    if (name === "geld") return S.geld;
    if (name === "stufe") return stufe();
    if (name === "ki") return SAMPLE ? 1 : 0;
    if (name in S.rel) return S.rel[name];
    return S.flags.includes(name) || S.items.includes(name) ? 1 : 0;
  }
  function einfach(c) {
    const m = c.match(/^(\w+)\s*(>=|<=|==|!=|>|<)\s*(-?\d+)$/);
    if (m) {
      const a = wert(m[1]), b = Number(m[3]);
      return { ">=": a >= b, "<=": a <= b, "==": a === b, "!=": a !== b, ">": a > b, "<": a < b }[m[2]];
    }
    if (c.startsWith("!")) return !wert(c.slice(1).trim());
    return !!wert(c);
  }
  function bedingung(c) { return !c || c.split("&&").every((p) => einfach(p.trim())); }

  // Applies effects. With aufwand 1 (the player only clicked a ready-made
  // sentence or said very little) friendship gains are withheld.
  function effekte(fx, aufwand) {
    const gewinn = [];
    for (const [k, v] of fx || []) {
      if (k === "item") { S.items.push(v); continue; }
      if (k === "flag") { if (!S.flags.includes(v)) S.flags.push(v); continue; }
      const n = Number(v) || 0;
      if (k === "geld") { S.geld += n; continue; }
      if (n > 0 && aufwand === 1) continue;
      S.rel[k] = (S.rel[k] || 0) + n;
      if (n > 0 && !gewinn.includes(k)) gewinn.push(k);
    }
    return gewinn;
  }
  function herzen(namen) {
    for (const n of namen) S.log.push({ typ: "notiz", t: "♥ " + n[0].toUpperCase() + n.slice(1) + " mag dich ein bisschen mehr." });
  }
  const text = (seg) => (typeof seg === "string" ? seg : seg.map((s) => (typeof s === "string" ? s : s[0])).join(""));

  function gesehen(seg) {
    const neu = [];
    if (!seg || typeof seg === "string") return neu;
    for (const s of seg) {
      if (typeof s === "string") continue;
      if (!S.seen[s[1]]) neu.push(s[1]);
      S.seen[s[1]] = (S.seen[s[1]] || 0) + 1;
    }
    return neu;
  }

  // ------------------------------------------------------------- engine
  function ziel(to) {
    if (to === "ENDE") return null;
    if (G.scenes[S.szene].nodes[to]) return [S.szene, to];
    const [sid, node] = to.split(".");
    return [sid, node || "start"];
  }
  function gehe(to, tiefe = 0) {
    const z = ziel(to);
    if (!z) return tagEnde();
    const [sid, node] = z;
    if (sid !== S.szene || !S.log.length) {
      S.szene = sid;
      S.tag = G.scenes[sid].tag;
      S.log.push({ typ: "titel", t: G.scenes[sid].titel });
    }
    S.knoten = node;
    spiele(tiefe);
  }
  function spiele(tiefe) {
    if (tiefe > 50) return;
    const choices = [];
    for (const ln of G.scenes[S.szene].nodes[S.knoten]) {
      if (ln.k !== "choice" && !bedingung(ln.if)) continue;
      if (ln.k === "narration" || ln.k === "dialogue") {
        S.log.push({ typ: ln.k, s: ln.s, t: ln.t, neu: gesehen(ln.t), bonus: !!ln.if && /stufe/.test(ln.if) });
      } else if (ln.k === "notiz") {
        const t = text(ln.t);
        if (!S.notiz.some((n) => n.t === t)) {
          S.notiz.push({ t, tag: S.tag });
          S.log.push({ typ: "notiz", t: "Neu im Notizbuch: „" + t + "“" });
        }
      } else if (ln.k === "choice") {
        if (bedingung(ln.if)) choices.push(ln);
      } else if (ln.k === "jump") {
        effekte(ln.fx);
        return gehe(ln.to, tiefe + 1);
      } else if (ln.k === "frei") {
        if (!SAMPLE) return gehe(ln.to, tiefe + 1);   // no AI: skip the task
        return starteAufgabe(ln);
      }
    }
    if (!choices.length) return tagEnde();
    S.warten = { typ: "wahl", optionen: choices, fehlversuche: 0, nachfragen: 0, versuch: 0, pending: null };
    vorschlaegeOffen = false; vollOffen = false;
    speichern();
    allesZeichnen();
  }
  function waehle(i, getippt, aufwand) {
    const c = S.warten.optionen[i];
    const wer = (sprecher() || "").toLowerCase();
    if (aufwand === undefined) aufwand = SAMPLE ? 1 : 2;
    S.warten = null;
    if (!getippt) S.log.push({ typ: "du", t: c.t, neu: gesehen(c.t) });
    const gewinn = effekte(c.fx, aufwand);
    const figur = Object.keys(G.figuren || {}).find((n) => n.toLowerCase() === wer);
    if (aufwand === 3 && figur) { S.rel[wer] = (S.rel[wer] || 0) + 1; if (!gewinn.includes(wer)) gewinn.push(wer); }
    herzen(gewinn);
    const verweigert = (c.fx || []).some(([k, v]) => !["geld", "item", "flag"].includes(k) && Number(v) > 0);
    if (aufwand === 1 && SAMPLE && verweigert && !S.tipp) {
      S.tipp = true;
      S.log.push({ typ: "notiz", t: "Tipp: Wenn du die Sätze selbst schreibst und mehr sagst, mögen dich die Leute mehr." });
    }
    gehe(c.to);
  }
  function tagEnde() {
    const tag = S.tag;
    const neu = G.order.filter((id) => G.scenes[id].tag === tag).flatMap((id) => G.scenes[id].neu);
    S.log.push({ typ: "notiz", t: "Tag " + tag + " ist vorbei. Heute neu: " + neu.length + " Wörter. Du hast " + S.geld + " ₰." });
    const formen = ((G.tage || {})[tag] || {}).tagebuch || [];
    if (SAMPLE && !S.tagebuch[tag]) S.warten = { typ: "tagebuch", tag, form: formen };
    else tagEndeKnopf();
    speichern();
    allesZeichnen();
  }
  function tagEndeKnopf() {
    S.warten = { typ: "tagende", naechste: G.order.find((id) => G.scenes[id].tag > S.tag) || null };
  }

  // ------------------------------------------------------------- tasks (frei:)
  function starteAufgabe(ln) {
    S.warten = { typ: "frei", wer: ln.s, thema: ln.thema, max: ln.max, n: 0, to: ln.to, ziel: ln.ziel,
                 braucht: ln.braucht || [], form: ln.form || [], lohn: ln.lohn || [], erfuellt: [], formOk: [],
                 versuch: 0, pending: null };
    if (ln.ziel || (ln.braucht && ln.braucht.length) || (ln.form && ln.form.length)) {
      gesehen(ln.ziel); (ln.braucht || []).forEach(gesehen);
      S.log.push({ typ: "aufgabe", ziel: ln.ziel, braucht: ln.braucht || [], form: ln.form || [] });
    }
    speichern();
    allesZeichnen();
  }
  function formErfuellt(f, s) {
    if (s.includes(f)) return true;
    return f === "nebensatz" && ["weil", "dass", "wenn"].some((x) => s.includes(x));
  }
  function aufgabeFertig(w) { return w.erfuellt.length >= w.braucht.length && w.form.every((f) => w.formOk.includes(f)); }
  function freiEnde(geschafft) {
    const w = S.warten;
    if (geschafft) {
      S.log.push({ typ: "notiz", t: "✓ Aufgabe geschafft." });
      const gewinn = effekte(w.lohn, 3);
      herzen(gewinn);
    } else if (w.braucht.length || w.form.length) {
      S.log.push({ typ: "notiz", t: "Die Aufgabe ist noch nicht ganz fertig. Das ist okay." });
    }
    S.warten = null;
    gehe(w.to);
  }

  // ------------------------------------------------------------- AI: shared
  function sprecher() {
    for (let i = S.log.length - 1; i >= 0; i--) if (S.log[i].typ === "dialogue") return S.log[i].s;
    return null;
  }
  function verlauf(n) {
    return S.log.filter((e) => ["dialogue", "narration", "du"].includes(e.typ)).slice(-n).map((e) =>
      e.typ === "du" ? "SPIELER: " + (e.roh || text(e.t)) : e.typ === "dialogue" ? e.s + ": " + text(e.t) : "(" + text(e.t) + ")"
    ).join("\n");
  }
  const figur = (name) => (G.figuren && G.figuren[name]) || "";
  function niveauText() {
    const n = S.profil.niveau;
    return n.length ? n.slice(-5).join(", ") : "unknown so far (start: " + START + ")";
  }
  function schwaechen() {
    const out = [];
    for (const [k, rec] of Object.entries(S.profil.fehler)) {
      if (KEINE_SCHWAECHE.includes(k)) continue;
      const f = rec.hist.slice(-8).filter((x) => x === "f").length;
      if (f >= 2) out.push([f, k, rec.bsp[rec.bsp.length - 1]]);
    }
    out.sort((a, b) => b[0] - a[0]);
    return out.slice(0, 3).map(([, k, b]) => k + " (" + KAT[k] + ")" + (b ? ', e.g. "' + b.falsch + '" instead of "' + b.richtig + '"' : "")).join("; ");
  }
  function kontext() {
    const sw = schwaechen(), lw = S.profil.nachgeschlagen.slice(-8);
    return `Day ${S.tag}. Money: ${S.geld} Pfennig. Items: ${S.items.join(", ") || "none"}.
Player's recent level estimates: ${niveauText()}. Text level for the game right now: ${STUFE_TEXT[stufe()]}` +
      (sw ? `\nThe player keeps making mistakes with: ${sw}. Where it fits the situation, steer the conversation so the player gets a natural reason to use these forms again (e.g. a question that needs the Perfekt with sein). Never mention grammar or that you noticed.` : "") +
      (lw.length ? `\nWords the player recently looked up: ${lw.join(", ")}. Reuse a few of them naturally in your reply, in simple, clear context, so the player meets them again.` : "");
  }
  const KORREKTUR = `Evaluate the player's German message:
- "korrekt": true when there is no real mistake. Ignore a lowercase first letter and missing final punctuation (chat style) but do flag lowercase nouns.
- Never mark something wrong because it is advanced, modern, slang or anachronistic: the player may use any German they know.
- "verstanden": false only when you cannot tell what the player means.
- If the player writes English or another language: "korrekt": false, "korrigiert" = a natural German version, one fehler with "kat": "sprache".
- "korrigiert": the message with the smallest edits that make it correct and natural; identical to the input when correct.
- "markiert": the player's ORIGINAL text with each wrong spot wrapped in [[double square brackets]]; unchanged when correct.
- "hinweis": one very short hint in simple German (max 8 words, no English) that names the kind of problem but NOT the answer, e.g. "Wo steht das Verb?", "Welcher Artikel?", "haben oder sein?". Empty when correct.
- "fehler": at most 3 items {"falsch","richtig","warum","kat"}; "warum" is simple German, max 12 words, no English; "kat" is one of: ${Object.keys(KAT).join(", ")}.
- "richtig_kat": categories from that list where the player correctly produced a form that learners often get wrong (e.g. "haben_sein" for a correct "ich bin gegangen").
- "aufwand": how much the player said, for their level: 1 = a single word, fragment or fixed phrase; 2 = one complete sentence; 3 = more than one clause, or a sentence with extra detail, a reason or a question back.
- "niveau": CEFR estimate of THIS message, one of ${CEFR.join(", ")}.
- "strukturen": constructions used CORRECTLY, from: ${Object.keys(FORM).join(", ")} (a weil/dass/wenn clause also counts as nebensatz).
- "grundformen": base forms of the content words used correctly (nouns capitalised).`;
  const EVAL_JSON = `"korrekt":true,"verstanden":true,"korrigiert":"","markiert":"","hinweis":"","fehler":[],"richtig_kat":[],"aufwand":2,"niveau":"${START}","strukturen":[],"grundformen":[]`;

  function normalisiere(r) {
    r = r && typeof r === "object" ? r : {};
    const arr = (x) => (Array.isArray(x) ? x : []);
    r.fehler = arr(r.fehler).filter((f) => f && typeof f === "object").slice(0, 3);
    r.korrekt = typeof r.korrekt === "boolean" ? r.korrekt : r.fehler.length === 0;
    r.strukturen = arr(r.strukturen).map(String);
    r.richtig_kat = arr(r.richtig_kat).map(String);
    r.grundformen = arr(r.grundformen).map(String);
    r.erfuellt = arr(r.erfuellt).map(Number).filter(Number.isInteger);
    r.aufwand = [1, 2, 3].includes(Number(r.aufwand)) ? Number(r.aufwand) : 2;
    r.korrigiert = String(r.korrigiert || "");
    r.markiert = String(r.markiert || "");
    r.hinweis = String(r.hinweis || "");
    return r;
  }

  // Mistake log: per category the last outcomes (f = mistake, o = correct) and examples.
  function fehlerBuchen(r, nurRichtig) {
    const p = S.profil;
    const rec = (k) => (p.fehler[k] = p.fehler[k] || { n: 0, ok: 0, hist: [], bsp: [] });
    if (!nurRichtig) {
      for (const f of r.fehler) {
        const k = KAT[f.kat] ? f.kat : "sonst";
        const x = rec(k);
        x.n++; x.hist.push("f");
        x.bsp.push({ falsch: String(f.falsch || ""), richtig: String(f.richtig || ""), warum: String(f.warum || "") });
        if (x.bsp.length > 3) x.bsp.shift();
      }
    }
    for (const k of r.richtig_kat) {
      if (!KAT[k]) continue;
      const x = rec(k);
      x.ok++; x.hist.push("o");
    }
    for (const x of Object.values(p.fehler)) if (x.hist.length > 14) x.hist = x.hist.slice(-14);
  }
  function profilUpdate(r, retry) {
    const p = S.profil;
    if (!retry) {
      p.runden++;
      if (r.korrekt) p.korrekt++;
    } else if (r.korrekt) p.selbst++;
    if (CEFR.includes(r.niveau)) { p.niveau.push(r.niveau); p.niveau = p.niveau.slice(-12); }
    for (const st of r.strukturen) p.strukturen[st] = (p.strukturen[st] || 0) + 1;
    for (const w of r.grundformen) if (w) p.eigene[w] = (p.eigene[w] || 0) + 1;
    fehlerBuchen(r, retry);
    // Unlock harder text early once the player shows the level (never lowers).
    const last = p.niveau.slice(-6).map((n) => CEFR.indexOf(n));
    const ab = (lvl) => last.filter((i) => i >= CEFR.indexOf(lvl)).length;
    const s = p.strukturen;
    let neu = p.stufe;
    if (ab("A2+") >= 3 || (s.praeteritum || 0) + (s.relativsatz || 0) + (s.passiv || 0) >= 4) neu = Math.max(neu, 2);
    if (ab("B1") >= 3 || (s.konjunktiv2 || 0) + (s.relativsatz || 0) >= 3) neu = Math.max(neu, 3);
    if (neu > p.stufe) {
      p.stufe = neu;
      S.log.push({ typ: "notiz", t: "Dein Deutsch wird besser! Ab jetzt sprechen die Leute mit dir auf Stufe " + neu + "." });
    }
  }

  function kiFehler(e, eingabe) {
    const code = e && e.code;
    if (["not_granted", "sampling_disabled", "not_declared", "capability_disabled", "capability_removed"].includes(code)) {
      SAMPLE = null;
      hinweis("Korrekturen sind aus. Du kannst mit den Vorschlägen weiterspielen.");
    } else if (code === "rate_limited") {
      hinweis("Zu viele Anfragen. Warte kurz und schick es dann noch einmal.");
    } else if (code !== "cancelled") {
      hinweis("Das hat nicht geklappt. Schick es noch einmal.");
    }
    if (eingabe) entwurf = eingabe;
  }

  // ------------------------------------------------------------- AI: prompts
  function promptWahl(w, wer, eingabe, retry) {
    const optionen = w.optionen.map((c, i) => `${i}: ${text(c.t)}`).join("\n");
    return `You are the language engine of a German-learning text game (comprehensible input). The player is a time traveler in Hamburg around 1370; everyone speaks modern, casual Hochdeutsch. The player never sees English.

Character speaking with the player: ${wer}. ${figur(wer)}
${kontext()}

Recent story:
${verlauf(8)}

The author's reply options (index: text):
${optionen}

The player typed: """${eingabe}"""
${retry ? "(This is the player's second try after a hint. Evaluate it fresh.)\n" : ""}
Tasks:
1. "wahl": the index of the option that best matches what the player MEANT (meaning, not wording), or -1 if none fits. A wrong-but-understandable sentence still selects its option.
2. ${KORREKTUR}
3. "recast": only when "korrekt" is false and the meaning was clear: one short, natural line by ${wer}, in character, that repeats the corrected form without lecturing (e.g. "Ah, du hast den Sack schon getragen!"). Otherwise "".
4. "antwort": only when "wahl" is -1: ${wer}'s short in-character reaction (1-2 sentences, at the game's text level), steering back to the situation so one of the options becomes natural. Otherwise "".
5. "nachfrage": only when "aufwand" is 1 and "wahl" is not -1: one short OPEN question (not yes/no) by ${wer}, in character, asking for more detail about the same topic, at the game's text level. Otherwise "".

Reply with only this JSON:
{"wahl":0,${EVAL_JSON},"recast":"","antwort":"","nachfrage":""}`;
  }
  function promptFrei(w, wer, eingabe, retry) {
    const bed = w.braucht.map((b, i) => `${i}: ${text(b)}${w.erfuellt.includes(i) ? " (already covered)" : ""}`).join("\n");
    const formen = w.form.map((f) => `${f} (${FORM[f][0]}: ${FORM[f][1]})${w.formOk.includes(f) ? " (already done)" : ""}`).join("; ");
    const aufgabe = (w.braucht.length || w.form.length) ? `
The player has a task: ${w.ziel ? text(w.ziel) : "talk with " + wer + "."}
Things the player still has to tell or ask (index: item):
${bed || "none"}
Constructions the player has to use correctly at least once: ${formen || "none"}.
Lead the conversation so the missing items come up naturally: ask about them one at a time, in character. If a construction is missing, give the player a natural reason to use it (e.g. ask "Was hast du heute gemacht?" for the Perfekt, "Warum?" for a weil-clause) without naming grammar. When everything is covered, wrap up warmly and set "ende": true.` : "";
    return `You are ${wer}, a character in a German-learning text game. The player is a time traveler in Hamburg around 1370; everyone speaks modern, casual Hochdeutsch. Never use English.
Your character: ${figur(wer)}
Scene: ${w.thema}
${kontext()}
Aim one small step above the player's recent level, never above B1+. Keep replies to 1-3 short sentences and end with a question or a hook so the player can answer. Be warm and a bit funny.${aufgabe}

Conversation so far:
${verlauf(10)}
SPIELER: ${eingabe}
${retry ? "(This is the player's second try after a hint. Evaluate it fresh.)\n" : ""}
${KORREKTUR}
If the player made a mistake, let your reply naturally repeat the corrected form once (a recast), without lecturing.
"erfuellt": indexes of ALL task items covered so far in the conversation, this message included (empty array if none).
Set "ende": true if the player clearly wants to stop or say good night, or if the task is complete.

Reply with only this JSON:
{"antwort":"","ende":false,"erfuellt":[],${EVAL_JSON}}`;
  }

  // ------------------------------------------------------------- AI: answering
  async function antworte(eingabe) {
    const w = S.warten;
    if (busy) return;
    const frei = w.typ === "frei";
    const wer = frei ? w.wer : (sprecher() || "Erzähler");
    const retry = w.versuch === 1;
    const prompt = frei ? promptFrei(w, wer, eingabe, retry) : promptWahl(w, wer, eingabe, retry);
    busy = new AbortController();
    const eintrag = { typ: "du", roh: eingabe, pruefen: true };
    S.log.push(eintrag);
    allesZeichnen();
    let r;
    try {
      r = normalisiere(await SAMPLE.json(prompt, { signal: busy.signal, modelTier: S.einst.tier, cache: false }));
    } catch (e) {
      busy = null;
      S.log.splice(S.log.indexOf(eintrag), 1);
      kiFehler(e, eingabe);
      return allesZeichnen();
    }
    busy = null;
    eintrag.pruefen = false;

    // 1. A real mistake the character understood: let the player repair it first.
    if (!retry && !r.korrekt && r.fehler.length && r.verstanden !== false) {
      profilUpdate(r, false);
      w.versuch = 1;
      w.pending = { eingabe, r };
      eintrag.rep = { markiert: r.markiert || eingabe, hinweis: r.hinweis };
      S.log.push({ typ: "dialogue", s: wer, t: RUECKFRAGEN[S.profil.runden % RUECKFRAGEN.length], ki: true });
      entwurf = eingabe;
      speichern();
      return allesZeichnen();
    }
    // 2. Final evaluation of this turn.
    const erster = retry ? w.pending.r : null;
    if (retry) { profilUpdate(r, true); w.versuch = 0; w.pending = null; }
    else profilUpdate(r, false);
    eintrag.k = { korrekt: r.korrekt, selbst: retry && r.korrekt, korrigiert: r.korrigiert, fehler: retry && !r.korrekt && erster ? erster.fehler : r.fehler };
    if (frei) return freiWeiter(w, wer, r);
    return wahlWeiter(w, wer, r, erster);
  }

  function wahlWeiter(w, wer, r, erster) {
    let i = Number.isInteger(r.wahl) && r.wahl >= 0 && r.wahl < w.optionen.length ? r.wahl : -1;
    if (i < 0 && erster && Number.isInteger(erster.wahl) && erster.wahl >= 0 && erster.wahl < w.optionen.length) i = erster.wahl;
    if (!r.korrekt && r.recast) S.log.push({ typ: "dialogue", s: wer, t: String(r.recast), ki: true });
    if (i >= 0) {
      if (r.aufwand === 1 && !erster && w.nachfragen < 1 && r.nachfrage) {
        w.nachfragen++;
        S.log.push({ typ: "dialogue", s: wer, t: String(r.nachfrage), ki: true });
        speichern();
        return allesZeichnen();
      }
      return waehle(i, true, r.aufwand);
    }
    if (r.antwort) S.log.push({ typ: "dialogue", s: wer, t: String(r.antwort), ki: true });
    w.fehlversuche = (w.fehlversuche || 0) + 1;
    if (w.fehlversuche >= 2) vorschlaegeOffen = true;
    speichern();
    allesZeichnen();
  }

  function freiWeiter(w, wer, r) {
    for (const i of r.erfuellt) if (i >= 0 && i < w.braucht.length && !w.erfuellt.includes(i)) w.erfuellt.push(i);
    for (const f of w.form) if (!w.formOk.includes(f) && r.strukturen.some((s) => formErfuellt(f, [s]))) w.formOk.push(f);
    if (r.antwort) S.log.push({ typ: "dialogue", s: wer, t: String(r.antwort), ki: true });
    w.n++;
    const aufgabe = w.braucht.length || w.form.length;
    if (aufgabe && aufgabeFertig(w)) return freiEnde(true);
    if ((r.ende && !aufgabe) || w.n >= w.max) return freiEnde(false);
    speichern();
    allesZeichnen();
  }

  // The player gives up on the repair: show the correction and carry on.
  function loesungZeigen() {
    const w = S.warten;
    if (!w || !w.pending || busy) return;
    const { r } = w.pending;
    const wer = w.typ === "frei" ? w.wer : (sprecher() || "Erzähler");
    const eintrag = [...S.log].reverse().find((e) => e.typ === "du" && e.rep);
    if (eintrag) eintrag.k = { korrekt: false, korrigiert: r.korrigiert, fehler: r.fehler };
    w.versuch = 0; w.pending = null;
    entwurf = "";
    if (w.typ === "frei") return freiWeiter(w, wer, r);
    wahlWeiter(w, wer, r, null);
  }

  // ------------------------------------------------------------- AI: diary
  async function tagebuchSenden(eingabe) {
    const w = S.warten;
    if (busy) return;
    const tag = w.tag;
    const neuListe = G.order.filter((id) => G.scenes[id].tag === tag).flatMap((id) => G.scenes[id].neu)
      .filter((l) => zaehlbar(l) && !istBekannt(l)).slice(0, 24);
    const formen = w.form.map((f) => `${f} (${FORM[f][0]}: ${FORM[f][1]})`).join("; ");
    const prompt = `You are the language engine of a German-learning text game. The player is a time traveler in Hamburg around 1370 and writes a short diary entry about their day in German.
${kontext()}

What happened today (for context):
${verlauf(30)}

Today's new words (base forms): ${neuListe.join(", ") || "none"}.
Constructions the player was asked to use: ${formen || "none"}.

The diary entry: """${eingabe}"""

${KORREKTUR}
Also return:
- "korrigiert": the whole entry corrected with minimal edits, keeping the player's voice and line breaks. Identical when correct.
- "genutzt": base forms from today's new words that the player used CORRECTLY.
- "formen_ok": the asked-for constructions (keys) the player used correctly at least once.
- "lob": one warm, specific sentence of encouragement in simple German (max 20 words) that names something the player did well.
(For a multi-sentence entry, "fehler" may list up to 5 items and "markiert" may be left empty.)

Reply with only this JSON:
{${EVAL_JSON},"genutzt":[],"formen_ok":[],"lob":""}`;
    busy = new AbortController();
    const eintrag = { typ: "du", roh: eingabe, pruefen: true, tagebuch: true };
    S.log.push(eintrag);
    allesZeichnen();
    let r;
    try {
      r = normalisiere(await SAMPLE.json(prompt, { signal: busy.signal, modelTier: "default", cache: false }));
    } catch (e) {
      busy = null;
      S.log.splice(S.log.indexOf(eintrag), 1);
      kiFehler(e, eingabe);
      return allesZeichnen();
    }
    busy = null;
    S.log.splice(S.log.indexOf(eintrag), 1);
    r.fehler = (Array.isArray(r.fehler) ? r.fehler : []).slice(0, 5);
    const genutzt = (Array.isArray(r.genutzt) ? r.genutzt : []).map(String).filter((l) => neuListe.includes(l));
    const formenOk = w.form.filter((f) => (Array.isArray(r.formen_ok) ? r.formen_ok : []).includes(f) || formErfuellt(f, r.strukturen));
    profilUpdate(r, false);
    const bonus = Math.min(3, Math.floor(genutzt.length / 2)) + (w.form.length && formenOk.length === w.form.length ? 1 : 0);
    S.geld += bonus;
    const eintragTb = { roh: eingabe, korrigiert: r.korrigiert || eingabe, fehler: r.fehler, lob: String(r.lob || ""),
                        genutzt, niveau: r.niveau, bonus, formenOk, formen: w.form };
    S.tagebuch[tag] = eintragTb;
    S.log.push({ typ: "tagebuch", tag, ...eintragTb });
    tagEndeKnopf();
    speichern();
    allesZeichnen();
  }
  function tagebuchUeberspringen() {
    S.tagebuch[S.warten.tag] = { uebersprungen: true };
    tagEndeKnopf();
    speichern();
    allesZeichnen();
  }

  // ------------------------------------------------------------- AI: word help
  async function kiErklaeren(wort, satz, box, knopf) {
    knopf.disabled = true;
    knopf.textContent = "Moment …";
    try {
      const { text: t } = await SAMPLE(
        `Explain the German word "${wort}" as used in this sentence: "${satz}". Write ONE or TWO very simple German sentences for an A2 learner (a simpler synonym or a short example). No English. Reply with only the explanation.`,
        { modelTier: "quick" });
      const d = document.createElement("div");
      d.textContent = t.trim();
      box.insertBefore(d, knopf);
      knopf.remove();
    } catch (e) {
      knopf.disabled = false;
      knopf.textContent = "Noch einmal versuchen";
      if (e && ["not_granted", "sampling_disabled"].includes(e.code)) { SAMPLE = null; knopf.remove(); }
    }
  }

  // ------------------------------------------------------------- render
  function zaehlbar(l) { const w = G.words[l] || {}; return !UNCOUNTED.has(w.k); }
  function istBekannt(l) { const w = G.words[l] || {}; return G.known_levels.includes(w.lvl); }
  function el(tag, txt, cls) { const e = document.createElement(tag); if (txt != null) e.textContent = txt; if (cls) e.className = cls; return e; }
  function wortSpan(txt, lemma, neu) {
    const span = el("span", txt, "w" + (lemma && neu && neu.includes(lemma) && zaehlbar(lemma) && !istBekannt(lemma) ? " neu" : ""));
    if (lemma) span.dataset.l = lemma; else span.dataset.ki = "1";
    return span;
  }
  function segmentHTML(seg, neu) {
    const frag = document.createDocumentFragment();
    if (typeof seg === "string") {                    // AI text: every word tappable
      for (const part of seg.split(/([A-Za-zÄÖÜäöüß]+)/)) {
        if (/^[A-Za-zÄÖÜäöüß]+$/.test(part)) frag.append(wortSpan(part, null)); else frag.append(part);
      }
      return frag;
    }
    for (const s of seg) frag.append(typeof s === "string" ? s : wortSpan(s[0], s[1], neu));
    return frag;
  }
  function markiertHTML(t) {
    const frag = document.createDocumentFragment();
    t.split(/(\[\[.+?\]\])/).forEach((p) => {
      if (/^\[\[.+\]\]$/.test(p)) frag.append(el("mark", p.slice(2, -2)));
      else frag.append(p);
    });
    return frag;
  }
  function korrekturHTML(k) {
    const wrap = el("div", null, "korrektur");
    if (k.korrekt) { wrap.append(el("span", k.selbst ? "✓ selbst korrigiert" : "✓ richtig", "ok")); return wrap; }
    const b = el("button", "✎ Korrektur", "chip");
    const det = el("div", null, "korr-detail");
    det.hidden = true;
    det.append(el("div", "Besser: „" + k.korrigiert + "“", "besser"));
    for (const f of k.fehler || []) {
      const row = el("div", null, "fehler");
      row.append(el("s", f.falsch || ""), " → ", el("strong", f.richtig || ""));
      if (f.warum) row.append(el("div", f.warum, "klein"));
      det.append(row);
    }
    b.onclick = () => { det.hidden = !det.hidden; };
    wrap.append(b, det);
    return wrap;
  }
  function formZeile(forms) {
    const row = el("div", null, "chips-zeile");
    for (const f of forms) {
      const c = el("span", FORM[f][0], "chip-stat form");
      c.title = FORM[f][1];
      row.append(c);
    }
    return row;
  }

  function allesZeichnen() {
    const log = $("#log");
    log.textContent = "";
    for (const e of S.log) {
      let p;
      if (e.typ === "titel") { p = el("h2", e.t, "szene-titel"); }
      else if (e.typ === "notiz") { p = el("p", e.t, "zeile notiz-hinweis"); }
      else if (e.typ === "aufgabe") {
        p = el("div", null, "aufgabe");
        p.append(el("div", "AUFGABE", "label"));
        if (e.ziel) { const z = el("p", null, "ziel"); z.append(segmentHTML(e.ziel)); p.append(z); }
        if (e.braucht.length) {
          const ul = el("ul", null, "braucht");
          e.braucht.forEach((b) => { const li = el("li"); li.append(segmentHTML(b)); ul.append(li); });
          p.append(ul);
        }
        if (e.form.length) {
          const wrap = el("div", null, "benutze");
          wrap.append(el("span", "Benutze:", "klein"), formZeile(e.form));
          p.append(wrap);
        }
      } else if (e.typ === "tagebuch") {
        p = el("div", null, "tagebuch-eintrag");
        p.append(el("div", "TAGEBUCH · TAG " + e.tag, "label"), el("p", e.roh, "roh"));
        const det = el("div", null, "korr-detail");
        det.append(el("div", "Besser:", "klein"), el("p", e.korrigiert, "besser"));
        for (const f of e.fehler || []) {
          const row = el("div", null, "fehler");
          row.append(el("s", f.falsch || ""), " → ", el("strong", f.richtig || ""));
          if (f.warum) row.append(el("div", f.warum, "klein"));
          det.append(row);
        }
        p.append(det);
        if (e.lob) p.append(el("p", e.lob, "lob"));
        const info = [];
        if (e.formen && e.formen.length) info.push(e.formen.map((f) => FORM[f][0] + (e.formenOk.includes(f) ? " ✓" : " ○")).join(", "));
        if (e.genutzt.length) info.push("Neue Wörter benutzt: " + e.genutzt.join(", "));
        if (e.bonus) info.push("+" + e.bonus + " ₰");
        if (info.length) p.append(el("div", info.join(" · "), "klein"));
      } else if (e.typ === "du") {
        p = el("div", null, "zeile du");
        const bubble = el("p", null, "du-text");
        if (e.rep) bubble.append(markiertHTML(e.rep.markiert));
        else if (e.roh != null) bubble.textContent = e.roh; else bubble.append(segmentHTML(e.t, e.neu));
        p.append(bubble);
        if (e.rep && e.rep.hinweis) p.append(el("div", "Hinweis: " + e.rep.hinweis, "klein hinweis-zeile"));
        if (e.pruefen) p.append(el("div", (sprecher() || "Jemand") + " hört zu …", "klein denkt"));
        if (e.k) p.append(korrekturHTML(e.k));
      } else {
        p = el("p", null, "zeile" + (e.typ === "dialogue" ? " dialog" : "") + (e.ki ? " ki" : "") + (e.bonus ? " bonus" : ""));
        if (e.s) p.append(el("span", e.s, "sprecher"), " ");
        p.append(segmentHTML(e.t, e.neu));
      }
      log.append(p);
    }
    zeichneEingabe();
    $("#tag").textContent = "TAG " + String(S.tag).padStart(2, "0");
    $("#ort").textContent = G.scenes[S.szene].ort;
    $("#geld").textContent = S.geld + " ₰";
    $("#stufe").textContent = "STUFE " + stufe();
    $("#wortzahl").textContent = Object.keys(S.seen).filter(zaehlbar).length;
    requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
  }

  function aufgabeChips(w) {
    const wrap = el("div", null, "status");
    const row = el("div", null, "chips-zeile");
    w.braucht.forEach((b, i) => {
      const ok = w.erfuellt.includes(i);
      row.append(el("span", (ok ? "✓ " : "○ ") + text(b), "chip-stat" + (ok ? " ok" : "")));
    });
    for (const f of w.form) {
      const ok = w.formOk.includes(f);
      const c = el("span", (ok ? "✓ " : "○ ") + FORM[f][0], "chip-stat form" + (ok ? " ok" : ""));
      c.title = FORM[f][1];
      row.append(c);
    }
    wrap.append(row);
    const fehlt = w.form.find((f) => !w.formOk.includes(f));
    if (fehlt) wrap.append(el("div", "Tipp: " + FORM[fehlt][1], "klein"));
    return wrap;
  }

  function stamm(t) {
    const ws = t.trim().split(/\s+/);
    return ws.length >= 4 ? ws.slice(0, 2).join(" ") + " …" : t;
  }
  function eingabeFormular(w, optionen) {
    const form = el("form", null, "tippen");
    const input = el("textarea");
    input.id = "eingabe-text";
    input.rows = 1;
    input.placeholder = w.versuch === 1 ? "Noch einmal – schreib den Satz besser …"
      : w.typ === "frei" ? "Sag etwas zu " + w.wer + " …" : "Antworte auf Deutsch …";
    input.setAttribute("aria-label", "Deine Antwort");
    input.disabled = !!busy;
    input.value = entwurf; entwurf = "";
    const grow = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 120) + "px"; };
    input.addEventListener("input", grow);
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); form.requestSubmit(); } });
    const send = el("button", busy ? "…" : "Senden", "senden");
    send.type = "submit";
    send.disabled = !!busy;
    form.append(input, send);
    form.onsubmit = (ev) => {
      ev.preventDefault();
      const t = input.value.trim();
      if (!t || busy) return;
      input.value = ""; entwurf = "";
      antworte(t);
    };
    if (!busy) setTimeout(() => { grow(); input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length); }, 0);
    return form;
  }

  function zeichneEingabe() {
    const box = $("#antworten");
    const alt = $("#eingabe-text");
    if (alt && !entwurf) entwurf = alt.value;
    box.textContent = "";
    const w = S.warten;
    if (!w) return;
    if (w.typ === "tagende") {
      const b = el("button", w.naechste ? "Weiter zu Tag " + G.scenes[w.naechste].tag : "Fortsetzung folgt …", "weiter");
      if (w.naechste) b.onclick = () => { S.warten = null; S.log = []; gehe(w.naechste + ".start"); };
      else b.disabled = true;
      box.append(b);
      return;
    }
    if (w.typ === "tagebuch") return zeichneTagebuch(box, w);
    const tippen = !!SAMPLE;
    if (w.typ === "frei" && !tippen) {
      const b = el("button", "Weiter", "weiter");
      b.onclick = () => freiEnde(false);
      box.append(b);
      return;
    }
    if (w.typ === "frei" && (w.braucht.length || w.form.length)) box.append(aufgabeChips(w));
    if (w.versuch === 1) {
      const row = el("div", null, "leiste repar");
      row.append(el("span", "Versuch es noch einmal.", "klein"));
      const l = el("button", "Lösung zeigen", "chip");
      l.disabled = !!busy;
      l.onclick = loesungZeigen;
      row.append(l);
      box.append(row);
    }
    if (tippen) box.append(eingabeFormular(w));
    if (w.typ === "frei") {
      const row = el("div", null, "leiste");
      row.append(el("span", (w.braucht.length || w.form.length ? "Aufgabe" : "Freies Gespräch") + " · " + w.n + "/" + w.max, "klein"));
      const end = el("button", w.braucht.length || w.form.length ? "Aufgabe beenden" : "Gespräch beenden", "chip");
      end.disabled = !!busy;
      end.onclick = () => freiEnde(aufgabeFertig(w) && (w.braucht.length > 0 || w.form.length > 0));
      row.append(end);
      box.append(row);
      return;
    }
    if (tippen && w.versuch !== 1) {
      const row = el("div", null, "leiste");
      const t = el("button", vorschlaegeOffen ? "Hilfe ausblenden" : "Hilfe: Satzanfänge", "chip");
      t.disabled = !!busy;
      t.onclick = () => { vorschlaegeOffen = !vorschlaegeOffen; zeichneEingabe(); };
      row.append(t);
      if (vorschlaegeOffen) {
        const g = el("button", vollOffen ? "Nur Anfänge" : "Ganze Sätze zeigen", "chip");
        g.disabled = !!busy;
        g.onclick = () => { vollOffen = !vollOffen; zeichneEingabe(); };
        row.append(g);
      }
      box.append(row);
    }
    if (!tippen || (vorschlaegeOffen && w.versuch !== 1)) {
      const list = el("div", null, "vorschlaege");
      const gezeigt = new Set();
      w.optionen.forEach((c, i) => {
        const voll = !tippen || vollOffen;
        const t = voll ? text(c.t) : stamm(text(c.t));
        if (gezeigt.has(t)) return;
        gezeigt.add(t);
        const b = el("button", t, "option" + (voll ? "" : " anfang"));
        b.disabled = !!busy;
        b.onclick = () => {
          if (voll) return waehle(i);
          entwurf = t.replace(/ …$/, "") + " ";
          zeichneEingabe();
        };
        list.append(b);
      });
      box.append(list);
    }
  }

  function zeichneTagebuch(box, w) {
    const card = el("div", null, "tagebuch-form");
    card.append(el("div", "TAGEBUCH · TAG " + w.tag, "label"));
    card.append(el("p", "Schreib 3 bis 5 Sätze über deinen Tag. Was hast du gemacht? Wen hast du getroffen?", "frage"));
    if (w.form.length) {
      const wrap = el("div", null, "benutze");
      wrap.append(el("span", "Benutze:", "klein"), formZeile(w.form));
      card.append(wrap, el("div", FORM[w.form[0]][1], "klein"));
    }
    const input = el("textarea");
    input.id = "tagebuch-text";
    input.rows = 4;
    input.setAttribute("aria-label", "Dein Tagebuch");
    input.placeholder = "Heute …";
    input.value = entwurf; entwurf = "";
    input.disabled = !!busy;
    const row = el("div", null, "leiste");
    const ok = el("button", busy ? "…" : "Abschicken", "senden");
    ok.disabled = !!busy;
    ok.onclick = () => { const t = input.value.trim(); if (t) { input.value = ""; tagebuchSenden(t); } };
    const skip = el("button", "Heute nicht", "chip");
    skip.disabled = !!busy;
    skip.onclick = tagebuchUeberspringen;
    row.append(skip, ok);
    card.append(input, row);
    box.append(card);
    if (!busy) setTimeout(() => input.focus({ preventScroll: true }), 0);
  }

  function hinweis(t) {
    const h = $("#hinweis");
    h.textContent = t;
    h.hidden = false;
    clearTimeout(hinweis.t);
    hinweis.t = setTimeout(() => { h.hidden = true; }, 6000);
  }

  // --------------------------------------------------------- word help
  function hilfe(span) {
    const l = span.dataset.l;
    const w = (l && G.words[l]) || {};
    const pop = $("#hilfe");
    $("#hilfe-wort").textContent = l || span.textContent;
    const box = $("#hilfe-text");
    box.textContent = "";
    const add = (t, cls) => { const d = el("div", t, cls); box.append(d); return d; };
    if (w.h) add(w.h);
    if (w.teile) add("Teile: " + w.teile.join(" + "));
    if (l && !w.h && !w.teile && span.textContent !== l) add("Grundform: " + l);
    const info = [];
    if (w.lvl) info.push("Wortliste " + w.lvl);
    if (ART[w.k]) info.push(ART[w.k]);
    const n = l ? S.seen[l] || 0 : 0;
    if (n) info.push(n === 1 ? "zum ersten Mal gesehen" : n + "-mal gesehen");
    if (info.length) add(info.join(" · "), "klein");
    if (l && G.words[l] && zaehlbar(l) && !istBekannt(l)) {      // remembered: the AI reuses these words
      const a = S.profil.nachgeschlagen, i = a.indexOf(l);
      if (i >= 0) a.splice(i, 1);
      a.push(l);
      if (a.length > 20) a.shift();
      speichern();
    }
    if (SAMPLE && !w.h) {
      const k = el("button", "Erklären", "chip");
      const satz = span.parentElement ? span.parentElement.textContent : span.textContent;
      k.onclick = (ev) => { ev.stopPropagation(); kiErklaeren(span.textContent, satz, box, k); };
      box.append(k);
    }
    document.querySelectorAll(".w.aktiv").forEach((x) => x.classList.remove("aktiv"));
    span.classList.add("aktiv");
    pop.hidden = false;
    const r = span.getBoundingClientRect();
    const top = r.bottom + 8 + pop.offsetHeight > innerHeight ? r.top - pop.offsetHeight - 8 : r.bottom + 8;
    pop.style.top = Math.max(8, top) + "px";
    pop.style.left = Math.max(16, Math.min(r.left, innerWidth - pop.offsetWidth - 16)) + "px";
  }

  // ------------------------------------------------------------- panels
  function tabs(box, liste, aktiv, wahl) {
    const row = el("div", null, "tabs");
    for (const [id, name] of liste) {
      const b = el("button", name, "chip" + (id === aktiv ? " an" : ""));
      b.onclick = () => wahl(id);
      row.append(b);
    }
    box.append(row);
  }
  function strip(hist) {
    return hist.slice(-10).map((x) => (x === "f" ? "✗" : "✓")).join("");
  }
  function panel(name) {
    const box = $("#panel-inhalt");
    box.textContent = "";
    if (name === "notizbuch") {
      $("#panel-titel").textContent = "Notizbuch";
      tabs(box, [["saetze", "Sätze"], ["tagebuch", "Tagebuch"], ["fehler", "Meine Fehler"]], panelTab, (t) => { panelTab = t; panel("notizbuch"); });
      if (panelTab === "saetze") {
        if (!S.notiz.length) box.append(el("p", "Noch leer.", "klein"));
        for (const t of [...new Set(S.notiz.map((n) => n.tag))]) {
          box.append(el("div", "Tag " + t, "label"));
          const ul = el("ul");
          S.notiz.filter((n) => n.tag === t).forEach((n) => ul.append(el("li", n.t)));
          box.append(ul);
        }
      } else if (panelTab === "tagebuch") {
        const tage = Object.keys(S.tagebuch).map(Number).sort((a, b) => a - b).filter((t) => !S.tagebuch[t].uebersprungen);
        if (!tage.length) box.append(el("p", "Noch kein Eintrag. Am Ende jedes Tages kannst du schreiben.", "klein"));
        for (const t of tage) {
          const e = S.tagebuch[t];
          box.append(el("div", "Tag " + t, "label"), el("p", e.roh, "roh"), el("div", "Besser:", "klein"), el("p", e.korrigiert, "besser"));
        }
      } else {
        const eintraege = Object.entries(S.profil.fehler).filter(([, x]) => x.n > 0)
          .sort((a, b) => b[1].hist.slice(-8).filter((x) => x === "f").length - a[1].hist.slice(-8).filter((x) => x === "f").length);
        if (!eintraege.length) box.append(el("p", "Noch keine Fehler notiert. Schreib und sprich, dann sammelt sich hier, woran du arbeiten kannst.", "klein"));
        else box.append(el("p", "Diese Stellen baut das Spiel immer wieder in die Gespräche ein.", "klein"));
        for (const [k, x] of eintraege) {
          const row = el("div", null, "fehler-zeile");
          row.append(el("strong", KAT[k] || k), el("span", strip(x.hist), "strip"),
            el("div", x.n + "× falsch · " + x.ok + "× richtig", "klein"));
          const b = x.bsp[x.bsp.length - 1];
          if (b) { const ex = el("div", null, "klein"); ex.append(el("s", b.falsch), " → ", el("strong", b.richtig)); row.append(ex); }
          box.append(row);
        }
      }
    } else if (name === "woerter") {
      const ls = Object.keys(S.seen).filter(zaehlbar).sort((a, b) => a.localeCompare(b, "de"));
      const eigene = Object.keys(S.profil.eigene).sort((a, b) => a.localeCompare(b, "de"));
      $("#panel-titel").textContent = "Wörter, die ich verstehe";
      box.append(el("p", ls.length + " Wörter gelesen, " + eigene.length + " selbst benutzt. Tippe auf ein Wort für Hilfe.", "klein"));
      if (eigene.length) {
        box.append(el("div", "Selbst benutzt", "label"));
        box.append(el("p", eigene.join(", "), "eigene"));
      }
      box.append(el("div", "Gelesen", "label"));
      const ul = el("ul", null, "woerter");
      for (const l of ls) {
        const li = el("li");
        const sp = el("span", l, "w"); sp.dataset.l = l;
        li.append(sp, el("span", " " + S.seen[l] + "×", "klein"));
        ul.append(li);
      }
      box.append(ul);
    } else if (name === "menue") {
      $("#panel-titel").textContent = "Menü";
      const m = el("div", null, "menue");
      const p = S.profil;
      const st = Object.entries(p.strukturen).sort((a, b) => b[1] - a[1]).map(([k, v]) => ((FORM[k] || [k])[0]) + " " + v + "×").join(", ");
      const info = el("div", null, "profil");
      info.append(el("div", "Dein Deutsch", "label"),
        el("div", "Geschätzt: " + (p.niveau.length ? p.niveau[p.niveau.length - 1] : "noch unbekannt") + " · Stufe " + stufe() + " frei"),
        el("div", p.runden ? p.korrekt + " von " + p.runden + " Antworten ganz richtig · " + p.selbst + "× selbst korrigiert" : "Noch keine getippten Antworten.", "klein"));
      if (st) info.append(el("div", "Richtig benutzt: " + st, "klein"));
      m.append(info);
      const rel = Object.entries(S.rel).map(([k, v]) => k[0].toUpperCase() + k.slice(1) + " " + "♥".repeat(Math.max(0, v))).join(" · ");
      if (rel || S.items.length) m.append(el("div", (rel ? "Freunde: " + rel + ". " : "") + (S.items.length ? "Du hast: " + S.items.join(", ") + "." : ""), "klein"));
      const b = (t, f, cls) => { const x = el("button", t, cls); x.onclick = f; m.append(x); return x; };
      if (SAMPLE) {
        m.append(el("div", "Korrekturen", "label"));
        const tier = b(S.einst.tier === "quick" ? "Modus: schnell (zu gründlich wechseln)" : "Modus: gründlich (zu schnell wechseln)", () => {
          S.einst.tier = S.einst.tier === "quick" ? "default" : "quick"; speichern(); panel("menue");
        });
        tier.title = "Gründlich ist genauer, aber langsamer.";
      }
      m.append(el("div", "Spielstand", "label"));
      m.append(el("div", DOC ? "Wird in deinem Konto gespeichert." : "Wird in diesem Browser gespeichert.", "klein"));
      if (!DOC && !window.claude) {     // save files only in the local version
        b("Spielstand herunterladen", exportieren);
        b("Spielstand laden …", () => $("#datei").click());
      }
      const reset = b(resetArmed ? "Wirklich? Noch einmal tippen" : "Neu anfangen", () => {
        if (!resetArmed) { resetArmed = true; panel("menue"); return; }
        resetArmed = false;
        S = neuesSpiel(); gehe("start"); schliessen();
      }, resetArmed ? "gefahr" : "");
      reset.id = "neu-anfangen";
      box.append(m);
    }
    const pn = $("#panel");
    pn.style.top = $("header").getBoundingClientRect().bottom + 8 + "px";
    pn.hidden = false;
  }
  function schliessen() {
    $("#panel").hidden = true; $("#hilfe").hidden = true; resetArmed = false;
    document.querySelectorAll(".w.aktiv").forEach((x) => x.classList.remove("aktiv"));
  }

  // --------------------------------------------------------------- init
  document.addEventListener("click", (ev) => {
    const w = ev.target.closest(".w");
    if (w) { hilfe(w); ev.stopPropagation(); return; }
    if (ev.target.closest(".zu")) { schliessen(); return; }
    const nb = ev.target.closest("nav button");
    if (nb) { panel(nb.dataset.panel); return; }
    if (!ev.target.closest(".popup, #panel")) $("#hilfe").hidden = true;
  });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") schliessen(); });
  $("#datei").addEventListener("change", (ev) => { if (ev.target.files[0]) importieren(ev.target.files[0]); ev.target.value = ""; });

  function start(st) {
    S = gueltig(st) ? st : null;
    if (S) {
      S.profil = Object.assign(neuesProfil(), S.profil || {});
      const alt = { "A2.1": "A2", "A2.2": "A2+" };           // older saves used a finer scale
      S.profil.niveau = S.profil.niveau.map((n) => alt[n] || n);
      S.tagebuch = S.tagebuch || {};
      S.einst = S.einst || { tier: "quick" };
      allesZeichnen();
    } else { S = neuesSpiel(); gehe("start"); }
  }

  async function boot() {
    const lokal = lokalLaden();
    if (!window.claude || !window.claude.use) return start(lokal);
    $("#log").append(el("p", "Lädt …", "zeile klein"));
    const [sample, db, user] = await Promise.all(["sample", "db", "user"].map((n) => window.claude.use(n).catch(() => null)));
    SAMPLE = sample;
    let stand = null;
    if (db && user) {
      try {
        const uid = await user.id();
        if (uid) {
          DOC = db.doc("data/users/" + uid + "/spielstand");
          const snap = await DOC.get();
          if (snap.exists) stand = (snap.data() || {}).stand;
        }
      } catch (e) { DOC = null; }
    }
    $("#log").textContent = "";
    start(gueltig(stand) ? stand : lokal);
  }
  boot();
})();
