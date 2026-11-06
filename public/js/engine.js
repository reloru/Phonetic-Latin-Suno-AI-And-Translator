// Classical Latin (1st century BC, educated urban speech) phonological engine.
//
// One parse per word (letters -> phonemes -> syllables -> stress), rendered four ways:
//   ipa     reference transcription, following Wiktionary's Classical-Latin conventions
//   hybrid  Latin spelling with targeted fixes for Suno ("Hīck ehgo sūm")
//   respell English-style respelling, hyphenated, stressed syllable in capitals ("AHT-kweh")
//   lyric   the same respelling as flowing words ("Heek ehgo soom")
//
// Phonology follows W. S. Allen, Vox Latina (2nd ed., 1978). The Suno-specific spellings
// are heuristics built from observed Suno behaviour, not from any Suno documentation.

import { lexKey, shardOf, cleanForm } from "./lexkey.js";

const VOWEL_LETTERS = "aeiouy";
const MACRON_OF = { a: "ā", e: "ē", i: "ī", o: "ō", u: "ū", y: "ȳ" };
const STOPS = new Set(["p", "b", "t", "d", "k", "g", "ph", "th", "kh", "f"]);
const LIQUIDS = new Set(["l", "r"]);
const VELARS = new Set(["k", "g", "kw", "gw", "kh"]);

// Words whose final syllable carries the accent (apocope of -ce / -e). Grammarians' rule
// reported in Allen, Vox Latina; Wiktionary's Classical IPA agrees for illīc and adhūc.
const FINAL_STRESS = new Set([
  "illīc", "illūc", "istīc", "istūc", "adhūc", "posthāc", "antehāc", "illinc", "istinc",
  // contracted -ās < -ātis (Arpīnās, nostrās); Wiktionary agrees for prīmās
  "arpīnās", "nostrās", "vestrās", "optimās", "prīmās", "cuiās",
]);
// Prefixes whose boundary blocks muta cum liquida onsets: ab|luō, ob|ruō, sub|lātus.
const MCL_PREFIX = /^(ab|ob|sub|ad)(?=[lr])/;
const UI_WORDS = new Set(["cui", "huic", "hui", "cuique", "cuiquam", "cuidam", "cuicumque", "huiusce", "huicce"]);
const EI_WORDS = new Set(["dein", "deinde", "deinceps", "proin", "proinde", "hei", "ei"]);
const EU_WORDS = new Set(["heu", "eheu", "neu", "seu", "ceu"]);
// Consonantal u after s (suāvis, persuādeō, cōnsuētūdō); suārum/suās stay vocalic.
const SU_CONSONANTAL = /su(?=āv|ād|āsī|āsu|āsit|āsiō|ēsc|ēt|ēv|ēb)/;
const CON_I_PREFIX = /^(ab|ad|con|dis|in|ob|per|sub)$/;

/** Parses one written word into letters with length marks. */
function letters(word) {
  const s = word
    .normalize("NFC")
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .normalize("NFD");
  const out = [];
  for (const ch of s) {
    const last = out[out.length - 1];
    if (/[̀-ͯ]/.test(ch)) {
      if (!last) continue;
      if (ch === "̄" || ch === "̂") last.macron = true;
      else if (ch === "̆") last.breve = true;
      else if (ch === "̈") last.diaer = true;
      else if (ch === "͡") last.tie = true;
      continue;
    }
    out.push({ ch, macron: false, breve: false, diaer: false, tie: false });
  }
  for (const l of out) {
    l.long = l.macron && !l.breve; // macron + breve = anceps, treated as short
    l.marked = l.macron || l.breve || l.diaer || l.tie;
  }
  return out;
}

const isVowelLetter = (l) => !!l && VOWEL_LETTERS.includes(l.ch);
const plain = (form) => lexKey(form);

/** Letters -> phoneme units. */
function segment(L, form) {
  const units = [];
  const word = form.normalize("NFC").toLowerCase();
  const plainWord = plain(word);
  const lastIsV = () => units.length > 0 && units[units.length - 1].k === "V";
  const C = (c, src, extra = {}) => units.push({ k: "C", c, src, ...extra });

  for (let i = 0; i < L.length; i++) {
    const x = L[i];
    const nx = L[i + 1];
    const ch = x.ch;

    if (VOWEL_LETTERS.includes(ch)) {
      // consonantal i
      if (ch === "i" && !x.marked) {
        const nextV = isVowelLetter(nx) && !nx.diaer;
        if (i === 0 && nextV && nx.ch !== "i" && !/^(iamb|iōn|iōt|iasp)/.test(word)) { C("j", "i"); continue; }
        if (i > 0 && lastIsV() && nextV) { C("j", "i", { gem: 1 }); C("j", "i", { gem: 2 }); continue; }
        if (i > 0 && nextV && CON_I_PREFIX.test(plainWord.slice(0, i)) && nx.ch !== "i" && nx.ch !== "e") { C("j", "i"); continue; }
        if (i > 0 && nextV && CON_I_PREFIX.test(plainWord.slice(0, i)) && nx.ch === "e" && !nx.long && /^(ab|ad|con|in|ob|sub)iec/.test(plainWord)) { C("j", "i"); continue; }
      }
      // consonantal u
      if (ch === "u" && !x.marked) {
        const nextV = isVowelLetter(nx) && !nx.diaer;
        if (i === 0 && nextV && nx.ch !== "u") { C("w", "u"); continue; }
        if (i > 0 && lastIsV() && nextV) { C("w", "u"); continue; }
        if (i > 0 && L[i - 1].ch === "s" && SU_CONSONANTAL.test(word.slice(i - 1))) { C("w", "u"); continue; }
      }
      // diphthongs
      if (!x.long && nx && isVowelLetter(nx) && !nx.long && !nx.diaer) {
        const pair = ch + nx.ch;
        const after = L[i + 2];
        const glideFollows = (nx.ch === "i" || nx.ch === "u") && isVowelLetter(after);
        let diph = false;
        if (x.tie) diph = true;
        else if (glideFollows) diph = false;
        else if (pair === "ae" || pair === "au") diph = true;
        else if (pair === "oe") diph = !(plainWord.startsWith("coe") && i === 1 && isVowelLetter(after));
        else if (pair === "ui") diph = UI_WORDS.has(plainWord);
        else if (pair === "ei") diph = EI_WORDS.has(plainWord);
        else if (pair === "eu") {
          // heu, neu, seu; word-initial eu- (Eurōpa) except forms of eō (eunt, eundum);
          // Greek words (marked by ph/th/ch/y/z) except a final -eus (Wiktionary ties those).
          const greek = /(ph|th|ch|rh|y|z)/.test(plainWord);
          diph = EU_WORDS.has(plainWord) || (i === 0 && after?.ch !== "n") || (greek && !/eus$/.test(plainWord.slice(i)));
        }
        if (diph) { units.push({ k: "V", v: ch, diph: pair, long: false }); i++; continue; }
      }
      units.push({ k: "V", v: ch, long: x.long, diph: null });
      continue;
    }

    switch (ch) {
      case "q":
        if (nx && (nx.ch === "u" || nx.ch === "v")) { C("kw", "qu"); i++; } else C("k", "q");
        break;
      case "g": {
        const prev = units[units.length - 1];
        if (prev && prev.c === "n" && nx?.ch === "u" && !nx.long && isVowelLetter(L[i + 2])) { C("gw", "gu"); i++; }
        else C("g", "g");
        break;
      }
      case "c":
        if (nx?.ch === "h") { C("kh", "ch"); i++; } else C("k", "c");
        break;
      case "p":
        if (nx?.ch === "h") { C("ph", "ph"); i++; } else C("p", "p");
        break;
      case "t":
        if (nx?.ch === "h") { C("th", "th"); i++; } else C("t", "t");
        break;
      case "r":
        if (nx?.ch === "h") { C("r", "rh"); i++; } else C("r", "r");
        break;
      case "x":
        C("k", "x", { xPart: 1 }); C("s", "x", { xPart: 2 });
        break;
      case "z":
        if (lastIsV() && isVowelLetter(nx)) { C("z", "z", { gem: 1 }); C("z", "z", { gem: 2 }); } else C("z", "z");
        break;
      case "v":
        C("w", "v");
        break;
      case "j":
        C("j", "j");
        break;
      default:
        C(ch, ch);
    }
  }

  // Assimilations and the ns/nf rule.
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const n = units[i + 1];
    if (u.k !== "C") continue;
    if (u.c === "b" && n && (n.c === "s" || n.c === "t")) u.c = "p"; // urbs [urps], obtineō [optineō]
    if ((u.c === "n" || u.c === "m") && n && VELARS.has(n.c)) u.c = "ŋ";
    if (u.c === "m" && n && (n.c === "t" || n.c === "d")) u.c = "n";
    if (u.c === "g" && n && n.c === "n") u.c = "ŋg"; // magnus [maŋnus] (Allen)
    if (u.c === "n" && n && (n.c === "s" || n.c === "f") && units[i - 1]?.k === "V" && !units[i - 1].diph) {
      // Vowels before ns/nf were long and nasalized; the n itself was weak (Cicero, Orator 159).
      const v = units[i - 1];
      if (!v.long) v.lengthened = true;
      v.long = true;
      v.nasal = true;
      u.c = "ñ";
    }
  }
  return units;
}

/** Phoneme units -> syllables. */
function syllabify(units, plainForm = "") {
  const pre = plainForm.match(MCL_PREFIX);
  const boundary = pre ? pre[1].length : -1; // index of first unit after the prefix
  let unitPos = 0;
  const startOf = new Map();
  for (const u of units) { startOf.set(u, unitPos); unitPos += u.src === "x" && u.xPart === 1 ? 1 : u.src === "x" ? 0 : (u.src?.length ?? 1); }
  const vIdx = units.map((u, i) => (u.k === "V" ? i : -1)).filter((i) => i >= 0);
  if (!vIdx.length) return [];
  const syl = vIdx.map((i) => ({ onset: [], nucleus: units[i], coda: [] }));
  syl[0].onset = units.slice(0, vIdx[0]);
  for (let s = 0; s < vIdx.length - 1; s++) {
    const cl = units.slice(vIdx[s] + 1, vIdx[s + 1]);
    let split;
    if (cl.length <= 1) split = 0;
    else {
      const a = cl[cl.length - 2];
      const b = cl[cl.length - 1];
      const mcl = STOPS.has(a.c) && LIQUIDS.has(b.c) && !a.xPart && !a.gem && startOf.get(b) !== boundary;
      split = cl.length - (mcl ? 2 : 1);
    }
    syl[s].coda = cl.slice(0, split);
    syl[s + 1].onset = cl.slice(split);
  }
  syl[syl.length - 1].coda = units.slice(vIdx[vIdx.length - 1] + 1);
  for (const s of syl) s.heavy = !!(s.nucleus.long || s.nucleus.diph || s.coda.length);
  return syl;
}

function stressIndex(syl, form, enclitic) {
  const n = syl.length;
  if (n <= 1) return 0;
  if (FINAL_STRESS.has(form)) return n - 1;
  if (enclitic && n >= 3) return n - 2; // virúmque, Mūsáque: accent before the enclitic
  if (n === 2) return 0;
  return syl[n - 2].heavy ? n - 2 : n - 3;
}

const hasMarks = (w) => /[̄̂̆̈͡]/.test(w.normalize("NFD"));

/**
 * Lexicon wrapper. `shards` maps shard name -> { key: "form|form" }.
 */
export function createLexicon(shards = {}, splits = new Set()) {
  return {
    lookup(key) {
      const sh = shards[shardOf(key, splits)];
      const v = sh ? sh[key] : undefined;
      return v ? v.split("|") : null;
    },
  };
}

/** Lexicon over a flat { key: "form|form" } map (what /api/lookup returns). */
export function lexiconFromEntries(entries = {}) {
  return {
    lookup(key) {
      const v = Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : undefined;
      return v ? v.split("|") : null;
    },
  };
}

/** Every lookup key `text` needs: each word, plus the base of a possible enclitic. */
export function lookupKeys(text) {
  const keys = new Set();
  for (const m of String(text).matchAll(WORD_RE)) {
    const k = lexKey(m[0]);
    keys.add(k);
    const enc = k.match(/^(.{2,}?)(que|ne|ue)$/);
    if (enc) keys.add(enc[1]);
  }
  return [...keys];
}

/** Shard names needed to look up every word in `text` (including enclitic bases). */
export function shardsFor(text, splits = new Set()) {
  return [...new Set(lookupKeys(text).map((k) => shardOf(k, splits)))];
}

/**
 * Resolves vowel lengths for one word.
 * mode: "auto"   input macrons are trusted; unmarked words are looked up.
 *       "verify" macrons are accepted only when the dictionary has that reading
 *                (for machine-translated text).
 */
function resolve(word, lexicon, mode) {
  const cleaned = cleanForm(word.replace(/[âêîôûŷ]/g, (c) => MACRON_OF[c.normalize("NFD")[0]]));
  const key = lexKey(cleaned);
  const cands = lexicon ? lexicon.lookup(key) : null;
  const notes = [];
  const marked = hasMarks(word) || /[âêîôûŷ]/.test(word);
  let form = cleaned;
  let source = "input";
  let enclitic = false;

  if (cands) {
    const match = cands.find((c) => c === cleaned || (lexKey(c) === key && marked && c === cleaned));
    if (marked && mode !== "verify") {
      if (!cands.includes(cleaned)) notes.push({ type: "input-differs", dictionary: cands });
    } else if (marked && match) {
      source = "input+dictionary";
    } else {
      form = cands[0];
      source = "dictionary";
      if (marked) notes.push({ type: "corrected", given: cleaned, dictionary: cands });
    }
    if (source !== "input" || !marked) {
      const distinct = cands.filter((c) => c !== form);
      if (distinct.length && source === "dictionary") notes.push({ type: "ambiguous", alternatives: distinct });
    }
  } else if (lexicon) {
    const m = key.match(/^(.{2,}?)(que|ne|ue)$/);
    const baseCands = m ? lexicon.lookup(m[1]) : null;
    if (m && baseCands) {
      const enc = cleaned.slice(cleaned.length - m[2].length);
      const baseMarked = marked ? cleaned.slice(0, cleaned.length - m[2].length) : null;
      const base = baseMarked && (mode !== "verify" || baseCands.includes(baseMarked)) ? baseMarked : baseCands[0];
      form = base + enc;
      source = marked && base === baseMarked ? "input" : "dictionary";
      enclitic = true;
      notes.push({ type: "enclitic", base, enclitic: enc });
    } else if (!marked) {
      source = "unknown";
      notes.push({ type: "unknown" });
    }
  }
  return { form, source, notes, enclitic };
}

/** Full analysis of one word. */
export function analyzeWord(word, { lexicon = null, mode = "auto" } = {}) {
  const r = resolve(word, lexicon, mode);
  const L = letters(r.form);
  const units = segment(L, r.form);
  const syl = syllabify(units, lexKey(r.form));
  const formNFC = r.form.normalize("NFC");
  const stress = syl.length ? stressIndex(syl, formNFC, r.enclitic) : -1;
  syl.forEach((s, i) => (s.stressed = i === stress));
  const notes = [...r.notes];
  for (const n of notes) {
    if (n.type !== "ambiguous") continue;
    // Alternatives that only differ in a final vowel do not move the accent.
    n.affectsStress = n.alternatives.some((alt) => {
      const s2 = syllabify(segment(letters(alt), alt), lexKey(alt));
      return s2.length !== syl.length || (s2.length && stressIndex(s2, alt.normalize("NFC"), r.enclitic) !== stress);
    });
  }
  if (FINAL_STRESS.has(formNFC)) notes.push({ type: "final-stress" });
  if (r.source === "unknown" && syl.length >= 3 && !syl[syl.length - 2].heavy) notes.push({ type: "stress-uncertain" });
  const cap = /^\p{Lu}/u.test(word);
  return { word, form: formNFC, source: r.source, cap, units, syllables: syl, stress, notes };
}

// ---------------------------------------------------------------- renderers

const IPA_SHORT = { a: "a", e: "ɛ", i: "ɪ", o: "ɔ", u: "ʊ", y: "y" };
const IPA_LONG = { a: "aː", e: "eː", i: "iː", o: "oː", u: "uː", y: "yː" };
const IPA_C = { k: "k", g: "ɡ", kw: "kʷ", gw: "ɡʷ", ph: "pʰ", th: "tʰ", kh: "kʰ", "ŋ": "ŋ", "ŋg": "ŋ", "ñ": "", j: "j", w: "w" };

function ipaWord(a, opts) {
  const syl = a.syllables;
  if (!syl.length) return a.word;
  const flat = syl.flatMap((s) => [...s.onset, s.nucleus, ...s.coda]);
  const nextOf = (u) => flat[flat.indexOf(u) + 1];
  const cons = (u) => {
    if (u.c === "l") {
      const n = nextOf(u);
      const p = flat[flat.indexOf(u) - 1];
      const exilis = (n && ((n.k === "V" && (n.v === "i" || n.v === "y") && !n.diph) || n.c === "l")) || (p && p.c === "l");
      return exilis ? "l" : "ɫ";
    }
    if (u.c === "kw" || u.c === "gw") {
      const n = nextOf(u);
      if (n && n.k === "V" && n.v === "u" && !n.diph) return u.c === "kw" ? "k" : "ɡ";
    }
    return IPA_C[u.c] ?? u.c;
  };
  const last = syl[syl.length - 1];
  const finalM = opts.ipaFinalM !== "keep" && last.coda.length === 1 && last.coda[0].c === "m" && syl.length >= 1;
  return syl
    .map((s, i) => {
      const v = s.nucleus;
      let nuc;
      if (v.diph) nuc = { ae: "ae̯", au: "au̯", oe: "oe̯", ei: "ei̯", eu: "eu̯", ui: "ui̯" }[v.diph] ?? v.diph;
      else {
        const nextSyl = syl[i + 1];
        const hiatus = nextSyl && nextSyl.onset.length === 0 && s.coda.length === 0;
        const isFinalM = finalM && i === syl.length - 1;
        if (v.nasal || isFinalM) nuc = v.v + "̃" + "ː";
        else if (v.long) nuc = IPA_LONG[v.v];
        else if (hiatus && "eiou".includes(v.v)) nuc = v.v;
        else nuc = IPA_SHORT[v.v] ?? v.v;
      }
      const dropNuc = (a.cut === "last" && i === syl.length - 1) || (a.cut === "first" && i === 0);
      const dropCoda = a.cut === "last" && i === syl.length - 1;
      const coda = (i === syl.length - 1 && finalM) || dropCoda ? [] : s.coda;
      const body = s.onset.map(cons).join("") + (dropNuc ? "" : nuc.normalize("NFC")) + coda.map(cons).join("");
      return (s.stressed && !dropNuc ? "ˈ" : "") + body;
    })
    .join(".")
    .replace(/\.ˈ/g, "ˈ");
}

function isFront(v) {
  return !!v && v.k === "V" && (v.v === "e" || v.v === "i" || v.v === "y") && v.diph !== "eu" ? true : !!v && v.k === "V" && (v.diph === "ae" || v.diph === "oe");
}

/** Suno hybrid: Latin spelling, macrons kept, targeted fixes. */
function hybridWord(a, opts) {
  const syl = a.syllables;
  if (!syl.length) return a.word;
  const flat = syl.flatMap((s) => [...s.onset, s.nucleus, ...s.coda]);
  const disyllable = syl.length === 2;
  const lastS = syl[syl.length - 1];
  const drop = new Set(a.cut === "last" ? [lastS.nucleus, ...lastS.coda] : a.cut === "first" ? [syl[0].nucleus] : []);
  let out = "";
  flat.forEach((u, i) => {
    if (drop.has(u)) return;
    const next = flat[i + 1];
    if (u.k === "V") {
      const s = syl.find((x) => x.nucleus === u);
      if (u.diph) out += u.diph === "ae" ? "ai" : u.diph === "oe" ? "oi" : u.diph;
      else if (u.long) out += MACRON_OF[u.v];
      else if (u.v === "u") out += opts.shortU ?? "ū";
      else if (disyllable && s.stressed && !s.coda.length && (u.v === "e" || u.v === "a")) out += u.v === "e" ? "eh" : "ah";
      else out += u.v;
      return;
    }
    switch (u.src) {
      // Always k: Suno V5+ sang final -ck as "-cks" (Hīck → "heeks") and read re-c- as the
      // English prefix "ree-"; k gave a hard [k] in both places.
      case "c":
        out += "k";
        break;
      case "g": {
        const geminateFirst = next && next.k === "C" && next.src === "g";
        if (!geminateFirst && isFront(next)) out += "gh";
        else out += "g";
        break;
      }
      case "ch": out += "k"; break;
      case "ph": out += "p"; break;
      case "th": out += "t"; break;
      case "rh": out += "r"; break;
      case "v": case "u": out += "w"; break;
      case "i": case "j": out += u.gem === 1 ? "i" : "y"; break;
      case "x": out += u.xPart === 1 ? "x" : ""; break;
      case "z": out += u.gem === 2 ? "" : "z"; break;
      default: out += u.src;
    }
  });
  return a.cap ? out[0].toUpperCase() + out.slice(1) : out;
}

const LONG_RESPELL = { a: "ah", e: "ay", i: "ee", o: "oh", u: "oo", y: "ü" };

function respellCons(u, style, ctx) {
  switch (u.c) {
    case "k": case "kh": return "k";
    case "kw": return "kw";
    case "gw": return "gw";
    case "g": return ctx.frontNext ? "gh" : "g";
    case "ŋg": return "ng";
    case "ŋ": return "n";
    case "ñ": return "n";
    case "ph": return "p";
    case "th": return "t";
    case "j": return "y";
    case "w": return "w";
    case "s": return style === "lyric" && ctx.intervocalic ? "ss" : "s";
    default: return u.c;
  }
}

function respellNucleus(s, i, syl, style, opts) {
  const v = s.nucleus;
  const codaJ = s.coda.length && s.coda[0].c === "j";
  if (v.diph) {
    switch (v.diph) {
      case "ae": return s.onset.length ? "ai" : "eye";
      case "au": return "ow";
      case "oe": return "oy";
      case "ei": return "ay";
      case "eu": return "ehoo";
      case "ui": return "wee";
      default: return v.diph;
    }
  }
  if (codaJ) return { a: "ai", e: "ey", i: "ee", o: "oy", u: "ooy", y: "üy" }[v.v];
  if (v.long) return (opts.lyricMacrons ?? "ō").includes(MACRON_OF[v.v]) ? MACRON_OF[v.v] : LONG_RESPELL[v.v];
  const open = s.coda.length === 0;
  const last = i === syl.length - 1;
  const beforeVowel = !last && syl[i + 1].onset.length === 0 && open;
  if (style === "respell") {
    switch (v.v) {
      case "a": return "ah";
      case "e": return "eh";
      case "i": return open ? "ih" : "i";
      case "o": return open && !last ? "aw" : "o";
      case "u": return "oo";
      case "y": return "ü";
    }
  }
  switch (v.v) {
    case "a": return "ah";
    case "e": return open && (i === 0 || last || beforeVowel) ? "eh" : "e";
    case "i": return beforeVowel ? "ih" : last && open ? "ee" : "i";
    case "o": return "o";
    case "u": return "oo";
    case "y": return "ü";
  }
  return v.v;
}

function respellWord(a, style, opts) {
  const syl = a.syllables;
  if (!syl.length) return a.word;
  const parts = syl.map((s, i) => {
    const frontNuc = isFront(s.nucleus);
    const prevOpen = i > 0 && syl[i - 1].coda.length === 0;
    const onset = s.onset
      .map((u, j) => respellCons(u, style, { frontNext: j === s.onset.length - 1 && frontNuc, intervocalic: prevOpen && s.onset.length === 1 }))
      .join("");
    const dropNuc = (a.cut === "last" && i === syl.length - 1) || (a.cut === "first" && i === 0);
    const dropCoda = a.cut === "last" && i === syl.length - 1;
    const nuc = dropNuc ? "" : respellNucleus(s, i, syl, style, opts);
    const codaUnits = dropCoda ? [] : s.coda.length && s.coda[0].c === "j" && !dropNuc ? s.coda.slice(1) : s.coda;
    const coda = codaUnits.map((u) => respellCons(u, style, {})).join("");
    return { text: onset + nuc + coda, stressed: s.stressed, onsetless: s.onset.length === 0 };
  });
  if (style === "respell") {
    const caps = parts.length > 1 && opts.stressCaps !== false;
    return parts.filter((p) => p.text).map((p) => (caps && p.stressed ? p.text.toUpperCase() : p.text)).join("-");
  }
  let out = "";
  parts.forEach((p, i) => {
    if (i > 0 && p.onsetless && syl[i - 1].coda.length === 0) out += "-";
    out += p.text;
  });
  return a.cap ? out[0].toUpperCase() + out.slice(1) : out;
}

// ---------------------------------------------------------------- text level

const WORD_RE = /[\p{L}̀-ͯ]+/gu;

/**
 * Elision (synaloepha) for sung verse: a word ending in a vowel or vowel + m loses that
 * final syllable rhyme before a word starting with a vowel or h + vowel. Before est/es
 * the e of est is lost instead (prodelision: bonum est -> bonum'st).
 */
function elide(tokens) {
  const idx = tokens.map((t, i) => (t.analysis ? i : -1)).filter((i) => i >= 0);
  for (let w = 0; w < idx.length - 1; w++) {
    const ta = tokens[idx[w]];
    const tb = tokens[idx[w + 1]];
    const a = ta.analysis;
    const b = tb.analysis;
    if (!a.syllables.length || !b.syllables.length) continue;
    if (tokens.slice(idx[w] + 1, idx[w + 1]).some((t) => t.tag || /\S/.test(t.text))) continue;
    const last = a.syllables[a.syllables.length - 1];
    const first = b.syllables[0];
    const endsVowel = last.coda.length === 0 || (last.coda.length === 1 && last.coda[0].c === "m");
    const startsVowel = first.onset.length === 0 || (first.onset.length === 1 && first.onset[0].c === "h");
    if (!endsVowel || !startsVowel) continue;
    if (b.form === "est" || b.form === "es") tb.cut = "first";
    else if (!ta.cut) ta.cut = "last";
  }
}

function renderToken(t, style, opts) {
  const a = t.analysis;
  if (!a) return t.text;
  const x = t.cut ? { ...a, cut: t.cut } : a;
  if (style === "ipa") return ipaWord(x, opts);
  if (style === "hybrid") return hybridWord(x, opts);
  return respellWord(x, style, opts);
}

/**
 * Converts text. Section-tag lines ([Verse], [Chorus]) and any [bracketed] span pass
 * through unchanged.
 * opts: { lexicon, mode: "auto"|"verify", elision: bool,
 *         shortU: "ū"|"u"|"oo"   short u in the hybrid (ū avoids Suno's "suhm"),
 *         lyricMacrons: "ō"      long vowels kept as macron letters in respell/lyric,
 *         stressCaps: bool       capitalize the stressed syllable in respell,
 *         ipaFinalM: "nasal"|"keep" }
 * Returns { ipa, hybrid, respell, lyric, words }.
 */
export function convert(text, opts = {}) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const outputs = { ipa: [], hybrid: [], respell: [], lyric: [] };
  const words = [];
  for (const line of lines) {
    const tokens = [];
    for (const seg of line.split(/(\[[^\]]*\])/)) {
      if (!seg) continue;
      if (/^\[[^\]]*\]$/.test(seg)) { tokens.push({ text: seg, tag: true }); continue; }
      let last = 0;
      for (const m of seg.matchAll(WORD_RE)) {
        if (m.index > last) tokens.push({ text: seg.slice(last, m.index) });
        const analysis = analyzeWord(m[0], opts);
        tokens.push({ text: m[0], analysis });
        words.push(analysis);
        last = m.index + m[0].length;
      }
      if (last < seg.length) tokens.push({ text: seg.slice(last) });
    }
    if (opts.elision) elide(tokens);
    for (const style of Object.keys(outputs)) {
      let s = "";
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const r = renderToken(t, style, opts);
        if (t.cut === "first") s = s.replace(/\s+$/, "") + "'" + r;
        else if (t.cut === "last") {
          s += r + "'";
          if (tokens[i + 1] && /^\s+$/.test(tokens[i + 1].text) && !tokens[i + 1].tag) i++;
        } else s += r;
      }
      outputs[style].push(s);
    }
  }
  const result = {};
  for (const k of Object.keys(outputs)) result[k] = outputs[k].join("\n");
  return { ...result, words };
}

/** Syllable breakdown in Latin spelling, stressed syllable in capitals: "il·LĪC". */
export function syllableDisplay(a) {
  if (!a.syllables.length) return a.word;
  const unitText = (u) => {
    if (u.k === "V") return u.diph ? u.diph : u.long ? MACRON_OF[u.v] : u.v;
    if ((u.src === "x" || u.src === "z") && (u.xPart === 2 || u.gem === 2)) return "";
    if (u.src === "u") return "v";
    if (u.src === "j") return "i";
    return u.src;
  };
  const txt = (s) => [...s.onset, s.nucleus, ...s.coda].map(unitText).join("");
  return a.syllables.map((s) => (s.stressed && a.syllables.length > 1 ? txt(s).toUpperCase() : txt(s))).join("·");
}

export { WORD_RE };
