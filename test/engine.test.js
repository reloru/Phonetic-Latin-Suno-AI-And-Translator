import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { convert, analyzeWord, createLexicon, shardsFor, syllableDisplay } from "../public/js/engine.js";

const lexDir = new URL("../public/lexicon/", import.meta.url);
function lexiconFor(text) {
  const shards = {};
  for (const s of shardsFor(text)) {
    try { shards[s] = JSON.parse(readFileSync(new URL(`${s}.json`, lexDir), "utf8")); } catch {}
  }
  return createLexicon(shards);
}
const run = (text, opts = {}) => convert(text, { lexicon: lexiconFor(text), ...opts });

// The user's own Suno-tested spellings are the golden outputs.
test("golden: Hīc ego sum", () => {
  const r = run("Hīc ego sum");
  assert.equal(r.hybrid, "Hīck ehgo sūm");
  assert.equal(r.lyric, "Heek ehgo soom");
});

test("golden: Iterum atque nōn iterum", () => {
  const r = run("Iterum atque nōn iterum");
  assert.equal(r.hybrid, "Iterūm atque nōn iterūm");
  assert.equal(r.lyric, "Iteroom ahtkweh nōn iteroom");
  assert.match(r.respell, /AHT-kweh nōn/);
});

test("golden: Illīc sum, etiam hīc sum", () => {
  const r = run("Illīc sum, etiam hīc sum");
  assert.equal(r.hybrid, "Illīck sūm, etiam hīck sūm");
});

test("unmarked input is macronized from the dictionary", () => {
  const r = run("Gallia est omnis divisa in partes tres");
  assert.equal(r.hybrid, "Gallia est omnis dīwīsa in partēs trēs");
  const non = run("non");
  assert.equal(non.words[0].form, "nōn");
  assert.equal(non.words[0].source, "dictionary");
});

test("the more frequent lemma wins an ambiguous spelling", () => {
  assert.equal(run("est").words[0].form, "est"); // sum, not edō (ēst)
  assert.equal(run("populus").words[0].form, "populus"); // not pōpulus 'poplar'
  const hic = run("hic").words[0];
  assert.equal(hic.form, "hic");
  assert.ok(hic.notes.some((n) => n.type === "ambiguous" && n.alternatives.includes("hīc")));
});

test("typed macrons are trusted, and a dictionary mismatch is reported", () => {
  const w = run("sūm").words[0];
  assert.equal(w.form, "sūm");
  assert.ok(w.notes.some((n) => n.type === "input-differs"));
});

test("verify mode rejects macrons the dictionary does not have", () => {
  const w = run("lūpus", { mode: "verify" }).words[0];
  assert.equal(w.form, "lupus");
  const ok = run("hīc", { mode: "verify" }).words[0];
  assert.equal(ok.form, "hīc");
});

test("a breve pins a short reading against the dictionary default", () => {
  const w = run("lĭber").words[0];
  assert.equal(w.form, "liber");
  assert.equal(w.source, "input");
  assert.ok(!w.notes.some((n) => n.type === "input-differs"));
  assert.equal(run("lĭber").hybrid, "lĭber".normalize("NFD").replace(/\u0306/g, "").normalize("NFC"));
});

test("circumflex input is read as a macron", () => {
  assert.equal(run("nôn").words[0].form, "nōn");
});

test("stress: penultimate law", () => {
  const stress = (w) => syllableDisplay(analyzeWord(w));
  assert.equal(stress("amīcus"), "a·MĪ·cus"); // heavy penult (long vowel)
  assert.equal(stress("dominus"), "DO·mi·nus"); // light penult
  assert.equal(stress("puella"), "pu·EL·la"); // heavy by position
  assert.equal(stress("tenebrae"), "TE·ne·brae"); // muta cum liquida does not make position
  assert.equal(stress("illīc"), "il·LĪC"); // apocopated final stress
});

test("stress: enclitic pulls the accent", () => {
  const r = run("Mūsaque");
  assert.match(r.respell, /moo-SAH-kweh/);
});

test("consonantal i and u", () => {
  assert.equal(analyzeWord("iam").units[0].c, "j");
  assert.equal(syllableDisplay(analyzeWord("maior")), "MAI·ior");
  assert.equal(analyzeWord("uir").units[0].c, "w");
  assert.equal(analyzeWord("nouus").units[2].c, "w");
  assert.equal(syllableDisplay(analyzeWord("suāvis")), "SVĀ·vis");
  assert.equal(syllableDisplay(analyzeWord("iniūria")), "in·IŪ·ri·a");
  assert.equal(analyzeWord("tuus").syllables.length, 2);
});

test("diphthongs and hiatus", () => {
  assert.equal(analyzeWord("Caesar").syllables[0].nucleus.diph, "ae");
  assert.equal(analyzeWord("aër").syllables.length, 2);
  assert.equal(analyzeWord("poēta").syllables.length, 3);
  assert.equal(analyzeWord("cui").syllables.length, 1);
  assert.equal(analyzeWord("deus").syllables.length, 2);
  assert.equal(analyzeWord("eunt").syllables.length, 2);
  assert.equal(analyzeWord("heu").syllables.length, 1);
});

test("consonant phonology", () => {
  const ipa = (w) => convert(w).ipa;
  assert.equal(ipa("urbs"), "ˈʊrps");
  assert.equal(ipa("magnus"), "ˈmaŋ.nʊs");
  assert.equal(ipa("cōnsul"), "ˈkõː.sʊɫ");
  assert.equal(ipa("lingua"), "ˈlɪŋ.ɡʷa");
  assert.equal(ipa("philosophia"), "pʰɪ.ɫɔˈsɔ.pʰi.a");
  assert.equal(ipa("rēx"), "ˈreːks");
});

test("Suno hybrid consonant fixes", () => {
  const h = (w) => convert(w).hybrid;
  assert.equal(h("Cicerō"), "Kikerō");
  assert.equal(h("genus"), "ghehnūs");
  assert.equal(h("vīvō"), "wīwō");
  assert.equal(h("Iūlius"), "Yūliūs");
  assert.equal(h("Caesar"), "Kaisar");
  assert.equal(h("ecce"), "ekke");
  assert.equal(h("pater"), "pahter");
});

test("section tags and bracketed spans pass through", () => {
  const r = run("[Verse 1]\nHīc ego sum [whispered]\n\n[Chorus]");
  assert.equal(r.lyric, "[Verse 1]\nHeek ehgo soom [whispered]\n\n[Chorus]");
  assert.equal(r.hybrid.split("\n")[0], "[Verse 1]");
});

test("elision for sung verse", () => {
  const r = convert("multum ille et terrīs", { elision: true });
  assert.equal(r.hybrid, "mūlt'ill'et terrīs");
  assert.equal(r.lyric, "moolt'ill'et terrees");
  const p = convert("bonum est", { elision: true });
  assert.equal(p.hybrid, "bonūm'st");
});

test("options: shortU and longO", () => {
  assert.equal(convert("sum", { shortU: "u" }).hybrid, "sum");
  assert.equal(convert("nōn", { lyricMacrons: "" }).lyric, "nohn");
  assert.equal(convert("Hīc sum", { lyricMacrons: "īōū" }).lyric, "Hīk soom");
  assert.equal(convert("atque", { stressCaps: false }).respell, "aht-kweh");
});

// Wiktionary's Classical-Latin IPA (built by its la-IPA module) is an independent check.
test("IPA agrees with Wiktionary's Classical transcriptions", () => {
  const corpus = JSON.parse(readFileSync(new URL("./fixtures/wiktionary-classical-ipa.json", import.meta.url), "utf8"));
  const norm = (s) => s.normalize("NFC").replace(/^[[/]|[\]/]$/g, "").replace(/s̠/g, "s");
  const stressPos = (s) => {
    const parts = s.replace(/ˈ/g, ".ˈ").split(".").filter(Boolean);
    return `${parts.findIndex((p) => p.startsWith("ˈ"))}:${parts.length}`;
  };
  let exact = 0, stress = 0, coreTotal = 0, coreStress = 0;
  for (const [form, ref, core] of corpus) {
    const mine = norm(convert(form).ipa);
    const r = norm(ref);
    if (mine === r) exact++;
    const s = stressPos(mine) === stressPos(r);
    if (s) stress++;
    if (core) { coreTotal++; if (s) coreStress++; }
  }
  const n = corpus.length;
  assert.ok(n > 1500, `corpus has ${n} entries`);
  assert.ok(exact / n >= 0.92, `exact IPA ${(100 * exact / n).toFixed(1)}%`);
  assert.ok(stress / n >= 0.985, `stress ${(100 * stress / n).toFixed(1)}%`);
  assert.ok(coreStress / coreTotal >= 0.995, `core stress ${(100 * coreStress / coreTotal).toFixed(1)}%`);
});
