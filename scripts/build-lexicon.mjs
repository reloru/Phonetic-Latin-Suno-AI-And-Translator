#!/usr/bin/env node
// Builds the vowel-length lexicon from the kaikki.org Wiktionary extract.
//
//   node scripts/build-lexicon.mjs [path-or-url]
//
// Default source: https://kaikki.org/dictionary/Latin/kaikki.org-dictionary-Latin.jsonl
// (about 1.25 GB; it is streamed, never stored). Wiktionary text is CC BY-SA 4.0,
// so the generated files under public/lexicon/ carry that license (see
// public/lexicon/LICENSE.md); the code in this repository stays MIT.
//
// Outputs:
//   public/lexicon/<shard>.json   { key: "form1|form2", ... }  key = normalized spelling
//   test/fixtures/wiktionary-classical-ipa.json  [[canonical, ipa], ...] validation corpus

import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lexKey, shardOf, cleanForm } from "../src/lexkey.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = process.argv[2] ?? "https://kaikki.org/dictionary/Latin/kaikki.org-dictionary-Latin.jsonl";

const SKIP_TAGS = new Set(["table-tags", "inflection-template", "class", "romanization"]);
const VALID = /^[a-zāēīōūȳăĕĭŏŭëïüäȫ̆͡]+$/u;

async function openLines() {
  if (/^https?:/.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`fetch ${src}: ${res.status}`);
    return createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity });
  }
  return createInterface({ input: createReadStream(src), crlfDelay: Infinity });
}

// Lemma frequency ranks from the DCC Latin Core Vocabulary (data/dcc-core-vocabulary.json).
// When one spelling has several macronized readings (est / ēst), the reading whose lemma
// ranks highest becomes the default; ties fall back to fewer macrons, then dictionary weight.
const dcc = JSON.parse(readFileSync(join(root, "data", "dcc-core-vocabulary.json"), "utf8"));
const lemmaRank = new Map();
for (const [lemmas, rank] of dcc.entries) {
  for (const l of lemmas) {
    const c = cleanForm(l);
    if (!lemmaRank.has(c) || lemmaRank.get(c) > rank) lemmaRank.set(c, rank);
  }
}
const UNRANKED = 100000;

// key -> Map(form -> { weight, rank })
const lex = new Map();
function add(raw, weight, lemmas) {
  const form = cleanForm(raw);
  if (!form || !VALID.test(form)) return;
  const key = lexKey(form);
  if (key.length < 1) return;
  let m = lex.get(key);
  if (!m) lex.set(key, (m = new Map()));
  let rank = UNRANKED;
  for (const l of lemmas) rank = Math.min(rank, lemmaRank.get(cleanForm(l)) ?? UNRANKED);
  const prev = m.get(form) ?? { weight: 0, rank: UNRANKED };
  m.set(form, { weight: prev.weight + weight, rank: Math.min(prev.rank, rank) });
}
const macronCount = (f) => (f.normalize("NFD").match(/\u0304/g) ?? []).length;

const ipaCorpus = [];
let lines = 0;
const rl = await openLines();
for await (const line of rl) {
  lines++;
  if (lines % 200000 === 0) process.stderr.write(`${lines} lines, ${lex.size} keys\n`);
  let d;
  try { d = JSON.parse(line); } catch { continue; }
  if (d.lang_code !== "la") continue;
  const forms = (d.forms ?? []).filter((f) => !(f.tags ?? []).some((t) => SKIP_TAGS.has(t)));
  const canonical = forms.find((f) => (f.tags ?? []).includes("canonical"))?.form ?? null;
  const formOf = (d.senses ?? []).flatMap((s) => (s.form_of ?? []).map((x) => x.word)).filter(Boolean);
  // A form-of entry belongs to the lemma(s) it points at; a lemma entry belongs to itself.
  const lemmas = formOf.length ? formOf : [canonical ?? d.word];
  for (const f of forms) add(f.form, (f.tags ?? []).includes("canonical") ? 3 : 1, lemmas);
  if (!canonical) add(d.word, 1, lemmas);
  // Validation corpus: Wiktionary's Classical-Latin IPA for every core-vocabulary lemma,
  // plus a deterministic 1-in-25 sample of all other lemmas.
  if (canonical && !formOf.length) {
    const c = cleanForm(canonical);
    const core = lemmaRank.has(c);
    if (core || lines % 25 === 0) {
      const ipa = (d.sounds ?? []).find((s) => s.ipa && (s.tags ?? []).includes("Classical-Latin"));
      if (ipa && c && VALID.test(c)) ipaCorpus.push([c, ipa.ipa, core ? 1 : 0]);
    }
  }
}

const shards = new Map();
for (const [key, forms] of lex) {
  const ordered = [...forms.entries()]
    .sort((a, b) => a[1].rank - b[1].rank || macronCount(a[0]) - macronCount(b[0]) || b[1].weight - a[1].weight || a[0].localeCompare(b[0]))
    .map(([f]) => f);
  const s = shardOf(key);
  if (!shards.has(s)) shards.set(s, {});
  shards.get(s)[key] = ordered.join("|");
}

const outDir = join(root, "public", "lexicon");
mkdirSync(outDir, { recursive: true });
const manifest = {};
for (const [s, obj] of [...shards.entries()].sort()) {
  const sorted = Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(join(outDir, `${s}.json`), JSON.stringify(sorted));
  manifest[s] = Object.keys(obj).length;
}
writeFileSync(join(outDir, "manifest.json"), JSON.stringify({ source: src, built: new Date().toISOString(), lines, keys: lex.size, shards: manifest }, null, 1));
mkdirSync(join(root, "test", "fixtures"), { recursive: true });
writeFileSync(join(root, "test", "fixtures", "wiktionary-classical-ipa.json"), JSON.stringify(ipaCorpus));
process.stderr.write(`done: ${lines} lines, ${lex.size} keys, ${shards.size} shards, ${ipaCorpus.length} IPA pairs\n`);
