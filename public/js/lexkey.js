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

const SHARD_BASE = 3;
const SHARD_MAX_BYTES = 150_000;
const pad = (key, n) => (key + "_".repeat(n)).slice(0, n);

/**
 * Shard name for a key: its first three letters ("_"-padded), extended one letter at a
 * time while that prefix is in `splits` (prefixes whose shard would exceed ~150 KB).
 */
export function shardOf(key, splits) {
  let n = SHARD_BASE;
  let p = pad(key, n);
  while (splits && splits.has(p) && n < 12) p = pad(key, ++n);
  return p;
}

/** Chooses which prefixes to split so that no shard exceeds SHARD_MAX_BYTES. */
export function planShards(entries) {
  const splits = new Set();
  let groups = new Map([["", entries]]);
  for (let n = SHARD_BASE; groups.size && n < 12; n++) {
    const next = new Map();
    for (const list of groups.values()) {
      const byPrefix = new Map();
      for (const e of list) {
        const p = pad(e[0], n);
        if (!byPrefix.has(p)) byPrefix.set(p, []);
        byPrefix.get(p).push(e);
      }
      for (const [p, l] of byPrefix) {
        const bytes = l.reduce((t, [k, v]) => t + k.length + v.length + 6, 0);
        if (bytes > SHARD_MAX_BYTES && l.some(([k]) => k.length > n)) { splits.add(p); next.set(p, l); }
      }
    }
    groups = next;
  }
  return splits;
}
