// Writes lexicon entries as adaptive prefix shards plus manifest.json (see lexkey.js).
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planShards, shardOf } from "../public/js/lexkey.js";

export function writeShards(outDir, entries, meta = {}) {
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) if (f.endsWith(".json")) rmSync(join(outDir, f));
  const splits = planShards(entries);
  const shards = new Map();
  for (const [k, v] of entries) {
    const s = shardOf(k, splits);
    if (!shards.has(s)) shards.set(s, []);
    shards.get(s).push([k, v]);
  }
  let largest = 0;
  for (const [s, list] of shards) {
    list.sort(([a], [b]) => (a < b ? -1 : 1));
    const body = JSON.stringify(Object.fromEntries(list));
    largest = Math.max(largest, body.length);
    writeFileSync(join(outDir, `${s}.json`), body);
  }
  const manifest = { ...meta, built: new Date().toISOString(), keys: entries.length, shards: shards.size, largestShardBytes: largest, splits: [...splits].sort() };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1));
  return manifest;
}
