// Moin, Zeitreisender – runner. All player-facing text is German.
// Works in two places: as a claude.ai Artifact (AI corrections, free talk,
// save in your account) and as a plain local file (choices only, browser save).
(function () {
  "use strict";
  const G = window.GAME;
  const KEY = "zeitreisender.v2";
  const $ = (s) => document.querySelector(s);
  const ART = { szene: "Hamburger Wort", slang: "Umgangssprache", name: "Name", interjektion: "Ausruf" };
  const UNCOUNTED = new Set(["name", "interjektion"]);
  const CEFR = ["A1", "A2.1", "A2.2", "B1-", "B1", "B1+", "B2"];
  const STUFE_TEXT = {
    1: "A2.1: Präsens, Perfekt, Modalverben, Imperativ; kurze Hauptsätze mit und/aber/weil; nur sehr häufige Wörter (Goethe A1/A2).",
    2: "A2.2 bis B1-: zusätzlich Präteritum, Nebensätze mit dass/wenn/weil, reflexive Verben, Vergleiche; Wörter bis Goethe B1, häufige zuerst.",
    3: "B1: zusätzlich Konjunktiv II (könnte, hätte, würde), Relativsätze, obwohl/damit/um … zu; längere zusammenhängende Sätze.",
  };

  let S = null;           // game state
  let SAMPLE = null;      // claude "sample" capability, null when unavailable
  let DOC = null;         // db document for this player's save, null when unavailable
  let busy = null;        // AbortController of the running AI call
  let vorschlaegeOffen = false;
  let resetArmed = false;

  // ------------------------------------------------------------- state
  function neuesSpiel() {
    return { v: 2, szene: G.order[0], knoten: "start", tag: G.scenes[G.order[0]].tag, geld: 0,
             rel: {}, items: [], flags: [], notiz: [], seen: {}, log: [], warten: null,
             profil: { niveau: [], strukturen: {}, eigene: {}, stufe: 1, runden: 0, korrekt: 0 },
             einst: { tier: "quick" } };
  }
  function tagStufe() {
    let st = 1;
    for (const [t, d] of Object.entries(G.tier_days)) if (S.tag >= d) st = Math.max(st, Number(t));
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

  // Download/upload of a save file: only offered outside the artifact.
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
        S = st; speichern(); allesZeichnen(); schliessen();
      } catch (e) { hinweis("Diese Datei ist kein Spielstand."); }
    };
    r.readAsText(file);
  }

  // ------------------------------------------------------------- rules
  function wert(name) {
    if (name === "geld") return S.geld;
    if (name === "stufe") return stufe();
    if (name in S.rel) return S.rel[name];
    return S.flags.includes(name) || S.items.includes(name) ? 1 : 0;
  }
  function bedingung(c) {
    if (!c) return true;
    const m = c.match(/^(\w+)\s*(>=|<=|==|!=|>|<)\s*(-?\d+)$/);
    if (m) {
      const a = wert(m[1]), b = Number(m[3]);
      return { ">=": a >= b, "<=": a <= b, "==": a === b, "!=": a !== b, ">": a > b, "<": a < b }[m[2]];
    }
    if (c.startsWith("!")) return !wert(c.slice(1));
    return !!wert(c);
  }
  function effekte(fx) {
    for (const [k, v] of fx || []) {
      if (k === "item") { S.items.push(v); continue; }
      if (k === "flag") { if (!S.flags.includes(v)) S.flags.push(v); continue; }
      const n = Number(v) || 0;
      if (k === "geld") S.geld += n; else S.rel[k] = (S.rel[k] || 0) + n;
    }
  }
  const text = (seg) => (typeof seg === "string" ? seg : seg.map((s) => (typeof s === "string" ? s : s[0])).join(""));

  function gesehen(seg) {
    const neu = [];
    if (typeof seg === "string") return neu;
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
        S.log.push({ typ: ln.k, s: ln.s, t: ln.t, neu: gesehen(ln.t), bonus: !!ln.if });
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
        if (!SAMPLE) return gehe(ln.to, tiefe + 1);   // no AI: skip the free talk
        S.warten = { typ: "frei", wer: ln.s, thema: ln.thema, max: ln.max, n: 0, to: ln.to };
        speichern();
        return allesZeichnen();
      }
    }
    if (!choices.length) return tagEnde();
    S.warten = { typ: "wahl", optionen: choices, fehlversuche: 0 };
    vorschlaegeOffen = false;
    speichern();
    allesZeichnen();
  }
  function waehle(i, getippt) {
    const c = S.warten.optionen[i];
    S.warten = null;
    if (!getippt) S.log.push({ typ: "du", t: c.t, neu: gesehen(c.t) });
    effekte(c.fx);
    gehe(c.to);
  }
  function tagEnde() {
    const tag = S.tag;
    const neu = G.order.filter((id) => G.scenes[id].tag === tag).flatMap((id) => G.scenes[id].neu);
    S.log.push({ typ: "notiz", t: "Tag " + tag + " ist vorbei. Heute neu: " + neu.length + " Wörter. Du hast " + S.geld + " ₰." });
    S.warten = { typ: "tagende", naechste: G.order.find((id) => G.scenes[id].tag > tag) || null };
    speichern();
    allesZeichnen();
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
  function niveauText() {
    const n = S.profil.niveau;
    return n.length ? n.slice(-5).join(", ") : "noch unbekannt (Start: A2.1)";
  }
  const KORREKTUR_REGELN = `Correction rules:
- Judge only real mistakes: grammar, word order, verb forms, gender/case, wrong word, meaning. Ignore a lowercase first letter and missing final punctuation (chat style), but do flag lowercase nouns.
- Never mark something wrong because it is advanced, modern, slang or anachronistic: the player may use any German they know.
- If the player writes English or another language, set "korrekt": false and give a natural German version in "korrigiert".
- "korrigiert": the player's sentence with the smallest edits that make it correct and natural; identical to the input when correct.
- "fehler": at most 3 items {"falsch","richtig","warum"}; "warum" is simple German, max 12 words, no English. Allowed terms: Nomen, Verb, Artikel, Dativ, Akkusativ, Perfekt, Präteritum, Nebensatz, Verb am Ende, Plural.
- "niveau": your CEFR estimate of THIS message, one of ${CEFR.join(", ")}.
- "strukturen": structures used CORRECTLY, from: perfekt, praeteritum, modalverb, imperativ, nebensatz, reflexiv, vergleich, konjunktiv2, relativsatz, passiv, zu_infinitiv.
- "grundformen": base forms of the content words the player used correctly (nouns with capital letter).`;
  function figur(name) { return (G.figuren && G.figuren[name]) || ""; }
  function zustand() {
    return `Day ${S.tag}. Money: ${S.geld} Pfennig. Items: ${S.items.join(", ") || "none"}.`;
  }

  function profilUpdate(r) {
    const p = S.profil;
    p.runden++;
    if (r.korrekt) p.korrekt++;
    if (CEFR.includes(r.niveau)) { p.niveau.push(r.niveau); p.niveau = p.niveau.slice(-12); }
    for (const st of r.strukturen || []) p.strukturen[st] = (p.strukturen[st] || 0) + 1;
    for (const w of r.grundformen || []) if (typeof w === "string" && w) p.eigene[w] = (p.eigene[w] || 0) + 1;
    // Unlock harder text early once the player shows the level (never lowers).
    const last = p.niveau.slice(-6).map((n) => CEFR.indexOf(n));
    const ab = (lvl) => last.filter((i) => i >= CEFR.indexOf(lvl)).length;
    const s = p.strukturen;
    let neu = p.stufe;
    if (ab("A2.2") >= 3 || (s.praeteritum || 0) + (s.nebensatz || 0) >= 4) neu = Math.max(neu, 2);
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
    const box = $("#eingabe-text");
    if (box && eingabe) box.value = eingabe;
  }

  // ------------------------------------------------------------- AI: typed answer to a choice
  async function antworteGetippt(eingabe) {
    const w = S.warten;
    const wer = sprecher() || "Erzähler";
    const optionen = w.optionen.map((c, i) => `${i}: ${text(c.t)}`).join("\n");
    const prompt = `You are the language engine of a German-learning text game (comprehensible input). The player is a time traveler in Hamburg around 1370; everyone speaks modern, casual Hochdeutsch. The player never sees English.

Character speaking with the player: ${wer}. ${figur(wer)}
${zustand()}
Player's recent level estimates: ${niveauText()}. Text level for the game right now: ${STUFE_TEXT[stufe()]}

Recent story:
${verlauf(8)}

The author's reply options (index: text):
${optionen}

The player typed: """${eingabe}"""

Tasks:
1. "wahl": the index of the option that best matches what the player MEANT (meaning, not wording), or -1 if none fits. A wrong-but-understandable sentence still selects its option.
2. Evaluate the German. ${KORREKTUR_REGELN}
3. "recast": only when "korrekt" is false and the meaning was clear: one short, natural line by ${wer}, in character, that repeats the corrected form without lecturing (e.g. "Ah, du hast den Sack schon getragen!"). Otherwise "".
4. "antwort": only when "wahl" is -1: ${wer}'s short in-character reaction (1-2 sentences, at the game's text level, a little above the player's level at most), steering back to the situation so one of the options becomes natural. Otherwise "".

Reply with only this JSON:
{"wahl":0,"korrekt":true,"korrigiert":"","fehler":[],"recast":"","antwort":"","niveau":"A2.1","strukturen":[],"grundformen":[]}`;
    busy = new AbortController();
    const eintrag = { typ: "du", roh: eingabe, pruefen: true };
    S.log.push(eintrag);
    allesZeichnen();
    try {
      const r = await SAMPLE.json(prompt, { signal: busy.signal, modelTier: S.einst.tier, cache: false });
      busy = null;
      eintrag.pruefen = false;
      eintrag.k = { korrekt: !!r.korrekt, korrigiert: String(r.korrigiert || ""), fehler: Array.isArray(r.fehler) ? r.fehler.slice(0, 3) : [] };
      profilUpdate(r);
      if (!r.korrekt && r.recast) S.log.push({ typ: "dialogue", s: wer, t: String(r.recast), ki: true });
      const i = Number.isInteger(r.wahl) ? r.wahl : -1;
      if (i >= 0 && i < w.optionen.length) return waehle(i, true);
      if (r.antwort) S.log.push({ typ: "dialogue", s: wer, t: String(r.antwort), ki: true });
      w.fehlversuche = (w.fehlversuche || 0) + 1;
      if (w.fehlversuche >= 2) vorschlaegeOffen = true;
      speichern();
      allesZeichnen();
    } catch (e) {
      busy = null;
      S.log.splice(S.log.indexOf(eintrag), 1);
      allesZeichnen();
      kiFehler(e, eingabe);
    }
  }

  // ------------------------------------------------------------- AI: free conversation
  async function freiSagen(eingabe) {
    const w = S.warten;
    const prompt = `You are ${w.wer}, a character in a German-learning text game. The player is a time traveler in Hamburg around 1370; everyone speaks modern, casual Hochdeutsch. Never use English.
Your character: ${figur(w.wer)}
Scene: ${w.thema}
${zustand()}
Language level: answer at "${STUFE_TEXT[stufe()]}" Aim one small step above the player's recent level (${niveauText()}), never above B1+. Keep replies to 1-3 short sentences and end with a question or a hook so the player can answer. Be warm and a bit funny.

Conversation so far:
${verlauf(10)}
SPIELER: ${eingabe}

Also evaluate the player's last message. ${KORREKTUR_REGELN}
If the player made a mistake, let your reply naturally repeat the corrected form once (a recast), without lecturing.
Set "ende": true if the player clearly wants to stop or say good night.

Reply with only this JSON:
{"antwort":"","ende":false,"korrekt":true,"korrigiert":"","fehler":[],"niveau":"A2.1","strukturen":[],"grundformen":[]}`;
    busy = new AbortController();
    const eintrag = { typ: "du", roh: eingabe, pruefen: true };
    S.log.push(eintrag);
    allesZeichnen();
    try {
      const r = await SAMPLE.json(prompt, { signal: busy.signal, modelTier: S.einst.tier, cache: false });
      busy = null;
      eintrag.pruefen = false;
      eintrag.k = { korrekt: !!r.korrekt, korrigiert: String(r.korrigiert || ""), fehler: Array.isArray(r.fehler) ? r.fehler.slice(0, 3) : [] };
      profilUpdate(r);
      if (r.antwort) S.log.push({ typ: "dialogue", s: w.wer, t: String(r.antwort), ki: true });
      w.n++;
      if (r.ende || w.n >= w.max) return freiEnde();
      speichern();
      allesZeichnen();
    } catch (e) {
      busy = null;
      S.log.splice(S.log.indexOf(eintrag), 1);
      allesZeichnen();
      kiFehler(e, eingabe);
    }
  }
  function freiEnde() {
    const to = S.warten.to;
    S.warten = null;
    gehe(to);
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
  function wortSpan(txt, lemma, neu) {
    const span = document.createElement("span");
    span.className = "w" + (lemma && neu && neu.includes(lemma) && zaehlbar(lemma) && !istBekannt(lemma) ? " neu" : "");
    span.textContent = txt;
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
  function el(tag, txt, cls) { const e = document.createElement(tag); if (txt != null) e.textContent = txt; if (cls) e.className = cls; return e; }

  function korrekturHTML(k) {
    const wrap = el("div", null, "korrektur");
    if (k.korrekt) { wrap.append(el("span", "✓ richtig", "ok")); return wrap; }
    const b = el("button", "✎ Korrektur", "chip");
    const det = el("div", null, "korr-detail");
    det.hidden = true;
    det.append(el("div", "Besser: „" + k.korrigiert + "“", "besser"));
    for (const f of k.fehler) {
      const row = el("div", null, "fehler");
      row.append(el("s", f.falsch || ""), " → ", el("strong", f.richtig || ""));
      if (f.warum) row.append(el("div", f.warum, "klein"));
      det.append(row);
    }
    b.onclick = () => { det.hidden = !det.hidden; };
    wrap.append(b, det);
    return wrap;
  }

  function allesZeichnen() {
    const log = $("#log");
    log.textContent = "";
    for (const e of S.log) {
      let p;
      if (e.typ === "titel") { p = el("h2", e.t, "szene-titel"); }
      else if (e.typ === "notiz") { p = el("p", e.t, "zeile notiz-hinweis"); }
      else if (e.typ === "du") {
        p = el("div", null, "zeile du");
        const bubble = el("p", null, "du-text");
        if (e.roh != null) bubble.textContent = e.roh; else bubble.append(segmentHTML(e.t, e.neu));
        p.append(bubble);
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

  function zeichneEingabe() {
    const box = $("#antworten");
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
    const tippen = !!SAMPLE;
    if (tippen) {
      const form = el("form", null, "tippen");
      const input = el("textarea");
      input.id = "eingabe-text";
      input.rows = 1;
      input.placeholder = w.typ === "frei" ? "Sag etwas zu " + w.wer + " …" : "Antworte auf Deutsch …";
      input.setAttribute("aria-label", "Deine Antwort");
      input.disabled = !!busy;
      input.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); form.requestSubmit(); } });
      const send = el("button", busy ? "…" : "Senden", "senden");
      send.type = "submit";
      send.disabled = !!busy;
      form.append(input, send);
      form.onsubmit = (ev) => {
        ev.preventDefault();
        const t = input.value.trim();
        if (!t || busy) return;
        (w.typ === "frei" ? freiSagen : antworteGetippt)(t);
      };
      box.append(form);
      if (!busy) setTimeout(() => input.focus({ preventScroll: true }), 0);
    }
    if (w.typ === "frei") {
      const row = el("div", null, "leiste");
      row.append(el("span", "Freies Gespräch · " + w.n + "/" + w.max, "klein"));
      const end = el("button", "Gespräch beenden", "chip");
      end.disabled = !!busy;
      end.onclick = freiEnde;
      row.append(end);
      box.append(row);
      return;
    }
    if (tippen) {
      const row = el("div", null, "leiste");
      const t = el("button", vorschlaegeOffen ? "Vorschläge ausblenden" : "Vorschläge zeigen", "chip");
      t.disabled = !!busy;
      t.onclick = () => { vorschlaegeOffen = !vorschlaegeOffen; zeichneEingabe(); };
      row.append(t);
      box.append(row);
    }
    if (!tippen || vorschlaegeOffen) {
      const list = el("div", null, "vorschlaege");
      w.optionen.forEach((c, i) => {
        const b = el("button", text(c.t), "option");
        b.disabled = !!busy;
        b.onclick = () => waehle(i);
        list.append(b);
      });
      box.append(list);
    }
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
  function panel(name) {
    const box = $("#panel-inhalt");
    box.textContent = "";
    if (name === "notizbuch") {
      $("#panel-titel").textContent = "Notizbuch";
      if (!S.notiz.length) box.append(el("p", "Noch leer.", "klein"));
      for (const t of [...new Set(S.notiz.map((n) => n.tag))]) {
        box.append(el("div", "Tag " + t, "label"));
        const ul = el("ul");
        S.notiz.filter((n) => n.tag === t).forEach((n) => ul.append(el("li", n.t)));
        box.append(ul);
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
      const st = Object.entries(p.strukturen).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + " " + v + "×").join(", ");
      const info = el("div", null, "profil");
      info.append(el("div", "Dein Deutsch", "label"),
        el("div", "Geschätzt: " + (p.niveau.length ? p.niveau[p.niveau.length - 1] : "noch unbekannt") + " · Stufe " + stufe() + " frei"),
        el("div", p.runden ? p.korrekt + " von " + p.runden + " Antworten ganz richtig" : "Noch keine getippten Antworten.", "klein"));
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
    if (S) { S.profil = S.profil || neuesSpiel().profil; S.einst = S.einst || { tier: "quick" }; allesZeichnen(); }
    else { S = neuesSpiel(); gehe("start"); }
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
