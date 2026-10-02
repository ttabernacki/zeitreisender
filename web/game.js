// Moin, Zeitreisender – browser runner. All player-facing text is German.
(function () {
  "use strict";
  const G = window.GAME;
  const KEY = "zeitreisender.v1";
  const $ = (s) => document.querySelector(s);
  const ART = { szene: "Hamburger Wort", slang: "Umgangssprache", name: "Name", interjektion: "Ausruf" };
  const UNCOUNTED = new Set(["name", "interjektion"]);

  let S = null;

  function neuesSpiel() {
    return { szene: G.order[0], knoten: "start", tag: G.scenes[G.order[0]].tag, geld: 0,
             rel: {}, items: [], flags: [], notiz: [], seen: {}, log: [], warten: null };
  }

  // ---------------------------------------------------------------- save
  function speichern() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
  function laden() {
    try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
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
        if (!st || !st.szene || !G.scenes[st.szene]) throw new Error();
        S = st; speichern(); allesZeichnen(); schliessen();
      } catch (e) { alert("Diese Datei ist kein Spielstand."); }
    };
    r.readAsText(file);
  }

  // ------------------------------------------------------------- state
  function wert(name) {
    if (name === "geld") return S.geld;
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
  function text(seg) { return seg.map((s) => (typeof s === "string" ? s : s[0])).join(""); }

  // Record words as seen; returns the set of lemmas seen for the first time.
  function gesehen(seg) {
    const neu = new Set();
    for (const s of seg) {
      if (typeof s === "string") continue;
      const l = s[1];
      if (!S.seen[l]) neu.add(l);
      S.seen[l] = (S.seen[l] || 0) + 1;
    }
    return [...neu];
  }

  // ------------------------------------------------------------- engine
  function ziel(to) {
    if (to === "ENDE") return null;
    const sc = G.scenes[S.szene];
    if (sc.nodes[to]) return [S.szene, to];
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
    const lines = G.scenes[S.szene].nodes[S.knoten];
    const choices = [];
    for (const ln of lines) {
      if (ln.k === "narration" || ln.k === "dialogue") {
        S.log.push({ typ: ln.k, s: ln.s, t: ln.t, neu: gesehen(ln.t) });
      } else if (ln.k === "notiz") {
        const t = text(ln.t);
        if (!S.notiz.some((n) => n.t === t)) S.notiz.push({ t, tag: S.tag });
        S.log.push({ typ: "notiz", t: "Neu im Notizbuch: „" + t + "“" });
      } else if (ln.k === "choice") {
        if (bedingung(ln.if)) choices.push(ln);
      } else if (ln.k === "jump") {
        effekte(ln.fx);
        return gehe(ln.to, tiefe + 1);
      }
    }
    if (!choices.length) return tagEnde();
    S.warten = { typ: "wahl", optionen: choices };
    speichern();
    allesZeichnen();
  }

  function waehle(i) {
    const c = S.warten.optionen[i];
    S.warten = null;
    S.log.push({ typ: "du", t: c.t, neu: gesehen(c.t) });
    effekte(c.fx);
    gehe(c.to);
  }

  function tagEnde() {
    const tag = S.tag;
    const neu = G.order.filter((id) => G.scenes[id].tag === tag).flatMap((id) => G.scenes[id].neu);
    S.log.push({ typ: "notiz", t: "Tag " + tag + " ist vorbei. Heute neu: " + neu.length + " Wörter. Du hast " + S.geld + " Pfennig." });
    const naechste = G.order.find((id) => G.scenes[id].tag > tag);
    S.warten = { typ: "tagende", naechste: naechste || null };
    speichern();
    allesZeichnen();
  }

  // ------------------------------------------------------------- render
  function zaehlbar(l) { const w = G.words[l] || {}; return !UNCOUNTED.has(w.k); }

  function segmentHTML(seg, neu) {
    const frag = document.createDocumentFragment();
    for (const s of seg) {
      if (typeof s === "string") { frag.append(s); continue; }
      const span = document.createElement("span");
      span.className = "w" + (neu && neu.includes(s[1]) && zaehlbar(s[1]) && !istBekannt(s[1]) ? " neu" : "");
      span.textContent = s[0];
      span.dataset.l = s[1];
      frag.append(span);
    }
    return frag;
  }
  function istBekannt(l) { const w = G.words[l] || {}; return G.known_levels.includes(w.lvl); }

  function allesZeichnen() {
    const log = $("#log");
    log.textContent = "";
    for (const e of S.log) {
      const p = document.createElement("p");
      if (e.typ === "titel") { p.className = "szene-titel"; p.textContent = e.t; }
      else if (e.typ === "notiz") { p.className = "zeile notiz-hinweis"; p.textContent = e.t; }
      else if (e.typ === "du") { p.className = "zeile du"; p.append(segmentHTML(e.t, e.neu)); }
      else {
        p.className = "zeile" + (e.typ === "dialogue" ? " dialog" : "");
        if (e.s) { const b = document.createElement("span"); b.className = "sprecher"; b.textContent = e.s + ":"; p.append(b, " "); }
        p.append(segmentHTML(e.t, e.neu));
      }
      log.append(p);
    }
    const box = $("#antworten");
    box.textContent = "";
    if (S.warten && S.warten.typ === "wahl") {
      S.warten.optionen.forEach((c, i) => {
        const b = document.createElement("button");
        b.textContent = text(c.t);
        b.onclick = () => waehle(i);
        box.append(b);
      });
    } else if (S.warten && S.warten.typ === "tagende") {
      const b = document.createElement("button");
      b.className = "weiter";
      if (S.warten.naechste) {
        b.textContent = "Weiter zu Tag " + G.scenes[S.warten.naechste].tag;
        b.onclick = () => { const n = S.warten.naechste; S.warten = null; S.log = []; gehe(n + ".start"); };
      } else {
        b.textContent = "Fortsetzung folgt …";
        b.disabled = true;
      }
      box.append(b);
    }
    $("#tag").textContent = "Tag " + S.tag;
    $("#ort").textContent = G.scenes[S.szene].ort;
    $("#geld").textContent = S.geld + " Pfennig";
    $("#wortzahl").textContent = Object.keys(S.seen).filter(zaehlbar).length;
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }

  // --------------------------------------------------------- word help
  function hilfe(span) {
    const l = span.dataset.l;
    const w = G.words[l] || {};
    const pop = $("#hilfe");
    $("#hilfe-wort").textContent = l;
    const box = $("#hilfe-text");
    box.textContent = "";
    const add = (t, cls) => { const d = document.createElement("div"); if (cls) d.className = cls; d.textContent = t; box.append(d); };
    if (w.h) add(w.h);
    if (w.teile) add("Teile: " + w.teile.join(" + "));
    if (!w.h && !w.teile && span.textContent !== l) add("Grundform: " + l);
    const info = [];
    if (w.lvl) info.push("Wortliste " + w.lvl);
    if (ART[w.k]) info.push(ART[w.k]);
    const n = S.seen[l] || 0;
    if (n) info.push(n === 1 ? "zum ersten Mal gesehen" : n + "-mal gesehen");
    add(info.join(" · "), "klein");
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
    const el = (tag, txt, cls) => { const e = document.createElement(tag); if (txt != null) e.textContent = txt; if (cls) e.className = cls; return e; };
    if (name === "notizbuch") {
      $("#panel-titel").textContent = "Notizbuch";
      if (!S.notiz.length) box.append(el("p", "Noch leer.", "klein"));
      const tage = [...new Set(S.notiz.map((n) => n.tag))];
      for (const t of tage) {
        box.append(el("div", "Tag " + t, "klein"));
        const ul = el("ul");
        S.notiz.filter((n) => n.tag === t).forEach((n) => ul.append(el("li", n.t)));
        box.append(ul);
      }
    } else if (name === "woerter") {
      const ls = Object.keys(S.seen).filter(zaehlbar).sort((a, b) => a.localeCompare(b, "de"));
      $("#panel-titel").textContent = "Wörter, die ich verstehe";
      box.append(el("p", ls.length + " Wörter. Tippe auf ein Wort für Hilfe.", "klein"));
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
      const b = (t, f) => { const x = el("button", t); x.onclick = f; m.append(x); };
      b("Spielstand herunterladen", exportieren);
      b("Spielstand laden …", () => $("#datei").click());
      b("Neu anfangen", () => { if (confirm("Wirklich neu anfangen? Dein Spielstand geht verloren.")) { S = neuesSpiel(); gehe("start"); schliessen(); } });
      const st = el("div", null, "klein");
      const rel = Object.entries(S.rel).map(([k, v]) => k[0].toUpperCase() + k.slice(1) + " " + "♥".repeat(Math.max(0, v))).join(" · ");
      st.textContent = (rel ? "Freunde: " + rel + ". " : "") + (S.items.length ? "Du hast: " + S.items.join(", ") + "." : "");
      m.append(st);
      box.append(m);
    }
    const pn = $("#panel");
    pn.style.top = $("header").getBoundingClientRect().bottom + 8 + "px";
    pn.hidden = false;
  }
  function schliessen() { $("#panel").hidden = true; $("#hilfe").hidden = true; document.querySelectorAll(".w.aktiv").forEach((x) => x.classList.remove("aktiv")); }

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

  S = laden();
  if (!S || !G.scenes[S.szene]) { S = neuesSpiel(); gehe("start"); }
  else allesZeichnen();
})();
