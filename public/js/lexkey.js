// Spelling normalization shared by the lexicon builder and the engine.

const MACRON = "̄";
const BREVE = "̆";
const TIE = "͡";
const COMBINING = /[̀-ͯ]/g;

/**
 * Normalizes a macronized dictionary form: lowercase, æ/œ expanded, breves dropped,
 * anceps (macron + breve on one vowel) reduced to an unmarked vowel, j written as i.
 * Keeps macrons, diaeresis and the diphthong tie. Returns NFC.
 */
export function cleanForm(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.trim().toLowerCase().replace(/æ/g, "ae").replace(/œ/g, "oe").normalize("NFD");
  s = s.replace(/([a-z])([̀-ͯ]+)/g, (_, base, marks) => {
    const hasMacron = marks.includes(MACRON);
    const hasBreve = marks.includes(BREVE);
    let kept = "";
    if (hasMacron && !hasBreve) kept += MACRON;
    if (marks.includes("̈")) kept += "̈";
    if (marks.includes(TIE)) kept += TIE;
    return base + kept;
  });
  return s.replace(/j/g, "i").normalize("NFC");
}

/** Lookup key: every diacritic stripped, j→i, v→u. */
export function lexKey(word) {
  return word
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .normalize("NFD")
    .replace(COMBINING, "")
    .replace(/j/g, "i")
    .replace(/v/g, "u");
}

/** Shard name for a key: its first two letters (a single-letter key gets "_"). */
export function shardOf(key) {
  return (key[0] ?? "_") + (key[1] ?? "_");
}
