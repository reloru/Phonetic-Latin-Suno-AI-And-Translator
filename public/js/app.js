import { convert, lookupKeys, syllableDisplay } from "./engine.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ------------------------------------------------------------- storage (best effort)
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ------------------------------------------------------------- dictionary
const dict = new Map(); // key -> "form|form" or null
let dictOnline = true;

async function ensureKeys(keys) {
  const missing = keys.filter((k) => !dict.has(k));
  for (let i = 0; i < missing.length; i += 1500) {
    const chunk = missing.slice(i, i + 1500);
    try {
      const res = await fetch("/api/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keys: chunk }) });
      if (!res.ok) throw new Error(String(res.status));
      const { entries } = await res.json();
      for (const k of chunk) dict.set(k, entries[k] ?? null);
      dictOnline = true;
    } catch {
      dictOnline = false;
      return;
    }
  }
}
const lexicon = { lookup: (k) => (dict.get(k) ? dict.get(k).split("|") : null) };

// ------------------------------------------------------------- tabs
function showTab(name) {
  for (const t of ["pronounce", "translate", "guide"]) {
    $(`#tab-${t}`).setAttribute("aria-selected", String(t === name));
    $(`#panel-${t}`).hidden = t !== name;
  }
  if (location.hash !== `#${name}`) history.replaceState(null, "", name === "pronounce" ? location.pathname : `#${name}`);
}
for (const t of ["pronounce", "translate", "guide"]) $(`#tab-${t}`).addEventListener("click", () => showTab(t));
showTab(["translate", "guide"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "pronounce");

// ------------------------------------------------------------- options
function readOptions() {
  return {
    elision: $("#opt-elision").checked,
    shortU: $("#opt-shortU").value,
    lyricMacrons: $$(".opt-mac").filter((c) => c.checked).map((c) => c.value).join(""),
    stressCaps: $("#opt-caps").checked,
    ipaFinalM: $("#opt-finalM").value,
  };
}
function applyOptions(o) {
  if (!o) return;
  $("#opt-elision").checked = !!o.elision;
  if (o.shortU) $("#opt-shortU").value = o.shortU;
  if (typeof o.lyricMacrons === "string") for (const c of $$(".opt-mac")) c.checked = o.lyricMacrons.includes(c.value);
  $("#opt-caps").checked = o.stressCaps !== false;
  if (o.ipaFinalM) $("#opt-finalM").value = o.ipaFinalM;
}
applyOptions(store.get("options", null));

// ------------------------------------------------------------- pronounce
const latin = $("#latin");
let mode = store.get("mode", "auto"); // "verify" while the text is unedited translator output
latin.value = store.get("latin", "Hīc ego sum\nIterum atque nōn iterum");

function setMode(m) {
  mode = m;
  store.set("mode", m);
  const note = $("#mode-note");
  note.hidden = m !== "verify";
  note.textContent = "Translator output: its macrons are checked against the dictionary. Edit the text to take control.";
}
setMode(mode);

let runId = 0;
async function run() {
  const id = ++runId;
  const text = latin.value;
  store.set("latin", text);
  const opts = readOptions();
  store.set("options", opts);
  const status = $("#dict-status");
  const keys = lookupKeys(text);
  if (keys.some((k) => !dict.has(k))) status.textContent = "Looking up vowel lengths…";
  await ensureKeys(keys);
  if (id !== runId) return;
  status.textContent = dictOnline ? "" : "Dictionary unavailable right now: vowels without macrons are treated as short.";
  status.classList.toggle("err", !dictOnline);
  const r = convert(text, { ...opts, mode, lexicon: dictOnline ? lexicon : null });
  for (const k of ["hybrid", "lyric", "respell", "ipa"]) $(`.out[data-out="${k}"] .text`).textContent = r[k];
  renderWords(r.words);
}

const NOTE_TEXT = {
  unknown: () => "Not in the dictionary: vowels you did not mark are read as short.",
  "stress-uncertain": () => "Stress depends on a vowel length the dictionary could not confirm.",
  "input-differs": (n) => `You typed this; the dictionary has ${n.dictionary.join(", ")}.`,
  corrected: (n) => `The translator wrote ${n.given}; the dictionary form is used.`,
  enclitic: (n) => `${n.base} + -${n.enclitic}: the accent falls just before the enclitic.`,
  "final-stress": () => "Accented on the last syllable (shortened from an older -ce form).",
};

function renderWords(words) {
  const list = $("#word-list");
  list.textContent = "";
  const seen = new Set();
  for (const w of words) {
    const id = `${w.word.toLowerCase()}|${w.form}`;
    if (seen.has(id) || !w.syllables.length) continue;
    seen.add(id);
    const li = document.createElement("li");
    const head = document.createElement("div");
    head.className = "w-head";
    const syl = document.createElement("span");
    syl.className = "w-syl";
    syl.lang = "la";
    syl.textContent = syllableDisplay(w);
    head.append(syl);
    const badge = document.createElement("span");
    badge.className = "badge" + (w.source === "unknown" ? " warn" : "");
    badge.textContent = { dictionary: "dictionary", input: "as typed", "input+dictionary": "checked", unknown: "unknown" }[w.source] ?? w.source;
    head.append(badge);
    li.append(head);
    for (const n of w.notes) {
      if (n.type === "ambiguous") {
        const p = document.createElement("div");
        p.className = "w-note" + (n.affectsStress ? " warn" : "");
        p.textContent = n.affectsStress ? "Other readings (these change the stress):" : "Other readings:";
        const alts = document.createElement("div");
        alts.className = "alts";
        for (const alt of n.alternatives.slice(0, 6)) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "alt";
          b.lang = "la";
          b.textContent = alt;
          b.addEventListener("click", () => replaceWord(w.word, alt, w.form));
          alts.append(b);
        }
        li.append(p, alts);
      } else if (NOTE_TEXT[n.type]) {
        const p = document.createElement("div");
        p.className = "w-note" + (["unknown", "stress-uncertain", "corrected"].includes(n.type) ? " warn" : "");
        p.textContent = NOTE_TEXT[n.type](n);
        li.append(p);
      }
    }
    list.append(li);
  }
}

// Splits an NFD string into [base letter, marks] clusters.
const clusters = (s) => [...s.normalize("NFD").matchAll(/(\P{M})(\p{M}*)/gu)].map((m) => [m[1], m[2]]);

/**
 * The spelling to write for a chosen reading: the chosen macrons, plus a breve on any
 * vowel the default reading has long but the choice has short (lĭber, not līber), so the
 * choice survives the next dictionary lookup. Breves never reach the Suno outputs.
 */
function spellChoice(original, chosen, defaultForm) {
  const c = clusters(chosen);
  const d = clusters(defaultForm);
  const o = clusters(original);
  if (c.length !== d.length || c.length !== o.length) return chosen;
  return o
    .map(([base], i) => {
      const cm = c[i][1].includes("̄") ? "̄" : "";
      const breve = !cm && d[i][1].includes("̄") ? "̆" : "";
      return base + cm + breve;
    })
    .join("")
    .normalize("NFC");
}

function replaceWord(original, alt, defaultForm) {
  const form = spellChoice(original, alt, defaultForm);
  const cased = /^\p{Lu}/u.test(original) ? form[0].toUpperCase() + form.slice(1) : form;
  const esc = original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\p{L}\\u0300-\\u036f])${esc}(?![\\p{L}\\u0300-\\u036f])`, "gu");
  latin.value = latin.value.replace(re, cased);
  setMode("auto");
  run();
}

let timer;
latin.addEventListener("input", () => {
  if (mode === "verify") setMode("auto");
  clearTimeout(timer);
  timer = setTimeout(run, 300);
});
for (const el of $$(".options input, .options select")) el.addEventListener("change", run);

// macron keys
function insertAtCursor(s) {
  const { selectionStart: a, selectionEnd: b, value } = latin;
  latin.value = value.slice(0, a) + s + value.slice(b);
  latin.selectionStart = latin.selectionEnd = a + s.length;
  latin.focus();
  latin.dispatchEvent(new Event("input"));
}
for (const b of $$(".keys [data-key]")) {
  b.addEventListener("pointerdown", (e) => e.preventDefault()); // keep the keyboard open
  b.addEventListener("click", () => insertAtCursor(b.dataset.key));
}
const PLAIN_TO_MACRON = { a: "ā", e: "ē", i: "ī", o: "ō", u: "ū", y: "ȳ", A: "Ā", E: "Ē", I: "Ī", O: "Ō", U: "Ū", Y: "Ȳ" };
const MACRON_TO_PLAIN = Object.fromEntries(Object.entries(PLAIN_TO_MACRON).map(([k, v]) => [v, k]));
$("#toggle-macron").addEventListener("pointerdown", (e) => e.preventDefault());
$("#toggle-macron").addEventListener("click", () => {
  const pos = latin.selectionStart;
  const v = latin.value;
  for (let i = pos - 1; i >= 0 && /[\p{L}]/u.test(v[i]); i--) {
    const swap = PLAIN_TO_MACRON[v[i]] ?? MACRON_TO_PLAIN[v[i]];
    if (swap) {
      latin.value = v.slice(0, i) + swap + v.slice(i + 1);
      latin.selectionStart = latin.selectionEnd = pos;
      latin.focus();
      latin.dispatchEvent(new Event("input"));
      return;
    }
  }
});

// copy buttons
async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  const label = btn.textContent;
  btn.textContent = "Copied";
  btn.classList.add("done");
  setTimeout(() => { btn.textContent = label; btn.classList.remove("done"); }, 1400);
}
for (const art of $$(".outputs .out")) {
  const btn = art.querySelector(".copy");
  btn.addEventListener("click", () => copyText(art.querySelector(".text").textContent, btn));
}

// ------------------------------------------------------------- translate
const trInput = $("#tr-input");
trInput.value = store.get("trInput", "");
$("#tr-direction").value = store.get("trDirection", "en-la");
$("#tr-style").value = store.get("trStyle", "lyrical");
$("#tr-greek").checked = store.get("trGreek", false);
$("#tr-key").value = store.get("accessKey", "");
$("#tr-key").addEventListener("change", () => store.set("accessKey", $("#tr-key").value.trim()));

$("#tr-go").addEventListener("click", async () => {
  const text = trInput.value.trim();
  if (!text) return;
  const direction = $("#tr-direction").value;
  store.set("trInput", trInput.value);
  store.set("trDirection", direction);
  store.set("trStyle", $("#tr-style").value);
  store.set("trGreek", $("#tr-greek").checked);
  const btn = $("#tr-go");
  const status = $("#tr-status");
  btn.disabled = true;
  status.classList.remove("err");
  status.textContent = "Translating… this can take up to a minute.";
  try {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "content-type": "application/json", ...($("#tr-key").value.trim() ? { "x-access-key": $("#tr-key").value.trim() } : {}) },
      body: JSON.stringify({ text, direction, style: $("#tr-style").value, greek: $("#tr-greek").checked }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const out = direction === "la-en" ? data.english : data.latin;
    $("#tr-result").hidden = false;
    $("#tr-result-h").textContent = direction === "la-en" ? "English" : "Latin";
    $("#tr-output").textContent = out;
    $("#tr-output").lang = direction === "la-en" ? "en" : "la";
    $("#tr-notes").textContent = data.notes || "";
    const extra = [];
    if (data.greek_loans?.length) extra.push(`Greek loanwords: ${data.greek_loans.join(", ")}`);
    if (data.neologisms?.length) extra.push(`Not Classical: ${data.neologisms.join(", ")}`);
    $("#tr-extra").textContent = extra.join(" · ");
    $("#tr-send").hidden = direction === "la-en";
    const fell = data.attempts?.find((a) => a.provider === "claude");
    status.textContent = `Translated by ${data.model}` + (fell ? ` (Claude unavailable: ${fell.error})` : "");
  } catch (e) {
    status.classList.add("err");
    status.textContent = `Translation failed: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});
$("#tr-copy").addEventListener("click", () => copyText($("#tr-output").textContent, $("#tr-copy")));
$("#tr-send").addEventListener("click", () => {
  latin.value = $("#tr-output").textContent;
  setMode("verify");
  showTab("pronounce");
  run();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

run();
