#!/usr/bin/env node
// Re-shards the existing public/lexicon/*.json without re-downloading the source data.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeShards } from "./shards.mjs";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "lexicon");
const old = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const entries = [];
for (const f of readdirSync(dir)) {
  if (!f.endsWith(".json") || f === "manifest.json") continue;
  entries.push(...Object.entries(JSON.parse(readFileSync(join(dir, f), "utf8"))));
}
const m = writeShards(dir, entries, { source: old.source, lines: old.lines });
console.log(`${m.keys} keys in ${m.shards} shards; largest ${m.largestShardBytes} bytes; ${m.splits.length} split prefixes`);
