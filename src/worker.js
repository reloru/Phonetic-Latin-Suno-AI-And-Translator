import Anthropic from "@anthropic-ai/sdk";
import { convert, lexiconFromEntries, lookupKeys, syllableDisplay } from "../public/js/engine.js";
import { shardOf } from "../public/js/lexkey.js";
import manifest from "../public/lexicon/manifest.json";

const WORKERS_AI_MODEL = "@cf/zai-org/glm-5.3";
const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
const MAX_TRANSLATE_CHARS = 4000;
const MAX_CONVERT_CHARS = 20000;
const MAX_LOOKUP_KEYS = 3000;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

// ------------------------------------------------------------------ lexicon

// Parsed shards stay in isolate memory between requests. The cache is bounded by raw
// JSON bytes (parsed size is roughly 4x) to stay far below the 128 MB isolate limit, and
// shards are loaded one at a time so a long text never holds many parsed shards at once.
const SPLITS = new Set(manifest.splits);
const shardCache = new Map(); // name -> { data, bytes }
const SHARD_CACHE_MAX_BYTES = 6_000_000;
let shardCacheBytes = 0;

async function loadShard(env, origin, name) {
  const hit = shardCache.get(name);
  if (hit) {
    shardCache.delete(name);
    shardCache.set(name, hit);
    return hit.data;
  }
  const res = await env.ASSETS.fetch(new Request(`${origin}/lexicon/${encodeURIComponent(name)}.json`));
  const body = res.ok ? await res.text() : "{}";
  const data = JSON.parse(body);
  shardCache.set(name, { data, bytes: body.length });
  shardCacheBytes += body.length;
  while (shardCacheBytes > SHARD_CACHE_MAX_BYTES && shardCache.size > 1) {
    const [oldest, v] = shardCache.entries().next().value;
    shardCache.delete(oldest);
    shardCacheBytes -= v.bytes;
  }
  return data;
}

async function lookup(env, origin, keys) {
  const byShard = new Map();
  for (const k of keys) {
    if (typeof k !== "string" || !/^[a-z]{1,40}$/.test(k)) continue;
    const s = shardOf(k, SPLITS);
    if (!byShard.has(s)) byShard.set(s, []);
    byShard.get(s).push(k);
  }
  const entries = {};
  for (const [s, ks] of byShard) {
    const shard = await loadShard(env, origin, s);
    for (const k of ks) if (Object.prototype.hasOwnProperty.call(shard, k)) entries[k] = shard[k];
  }
  return entries;
}

// ------------------------------------------------------------------ translation

const LATIN_SCHEMA = {
  type: "object",
  properties: {
    latin: { type: "string" },
    notes: { type: "string" },
    greek_loans: { type: "array", items: { type: "string" } },
    neologisms: { type: "array", items: { type: "string" } },
  },
  required: ["latin", "notes", "greek_loans", "neologisms"],
  additionalProperties: false,
};
const ENGLISH_SCHEMA = {
  type: "object",
  properties: { english: { type: "string" }, notes: { type: "string" } },
  required: ["english", "notes"],
  additionalProperties: false,
};

function systemPrompt({ direction, style, greek }) {
  if (direction === "la-en") {
    return [
      "You translate Latin into natural, accurate English.",
      "Keep the line breaks of the input one-to-one, and copy any [bracketed] section tags unchanged.",
      'In "notes", briefly mention real ambiguities (a word with two readings, an unclear construction) and nothing else; use an empty string if there are none.',
      "Reply with a JSON object only.",
    ].join("\n");
  }
  return [
    "You translate English into Latin for song lyrics. An AI singer will perform the Latin with reconstructed Classical pronunciation, so spelling and vowel length matter.",
    "",
    "Language: Classical Latin of the 1st century BC (Cicero, Caesar, Catullus, Lucretius; Vergil and Horace are acceptable). Prefer vocabulary and idiom attested in that period. When a concept has no Classical word, use the most established Neo-Latin term and list it in \"neologisms\".",
    style === "literal"
      ? "Style: stay close to the English meaning and structure."
      : "Style: natural, singable Latin. Free word order and poetic idiom are welcome; keep each line roughly as long as the English line.",
    greek
      ? 'Where a Greek loanword was established in Classical Latin (philosophia, poēta, aethēr, cithara, chorus), prefer it when it fits. List every Greek loanword you used in "greek_loans".'
      : 'Prefer native Latin words. List any Greek loanword you still used in "greek_loans".',
    "",
    "Spelling:",
    "- Mark every long vowel with a macron (ā ē ī ō ū ȳ), including hidden quantities before two consonants (āctus, mīlle, cōnsul). Leave short vowels unmarked. Never use breves, acute accents or circumflexes.",
    "- Write consonantal u as v (vīta) and consonantal i as i, never j (iam, cuius). Write ae and oe, not æ or œ.",
    "",
    "Layout: keep the line breaks of the input one-to-one. Copy any [bracketed] section tags such as [Verse] or [Chorus] unchanged. Text in (parentheses) is sung backing vocals: translate it and keep the parentheses.",
    "",
    'In "notes", give at most three short sentences on choices a singer should know about (an idiom you chose, a word with no Classical equivalent). Use an empty string if there is nothing worth saying.',
    "Reply with a JSON object only.",
  ].join("\n");
}

function parseJsonLoose(text) {
  if (typeof text !== "string") return null;
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

class ProviderError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function translateClaude(env, req) {
  const client = new Anthropic({
    baseURL: `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_ID || "default"}/anthropic`,
    // No Anthropic key: AI Gateway Unified Billing pays from Cloudflare credits.
    apiKey: null,
    authToken: null,
    defaultHeaders: { "cf-aig-authorization": `Bearer ${env.CLAUDE_GATEWAY_TOKEN}`, Authorization: null, "X-Api-Key": null },
    maxRetries: 1,
    timeout: 120_000,
  });
  const model = env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
  try {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: req.direction === "la-en" ? ENGLISH_SCHEMA : LATIN_SCHEMA } },
      system: systemPrompt(req),
      messages: [{ role: "user", content: req.text }],
    });
    if (response.stop_reason === "refusal") throw new ProviderError("Claude declined this request", { code: "refusal" });
    if (response.stop_reason === "max_tokens") throw new ProviderError("Claude ran out of output tokens", { code: "max_tokens" });
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const data = parseJsonLoose(text);
    if (!data) throw new ProviderError("Claude returned no parsable JSON", { code: "bad_json" });
    return { data, provider: "claude", model: response.model || model };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (e instanceof Anthropic.APIError) {
      const credits = e.status === 402;
      throw new ProviderError(credits ? "AI Gateway has no Unified Billing credits" : `Claude via AI Gateway failed (${e.status ?? "network"})`, {
        status: e.status,
        code: credits ? "no_credits" : "api_error",
      });
    }
    throw new ProviderError(`Claude via AI Gateway failed: ${e.message}`, { code: "network" });
  }
}

async function translateWorkersAI(env, req) {
  const schemaHint =
    req.direction === "la-en"
      ? 'Return exactly: {"english": string, "notes": string}'
      : 'Return exactly: {"latin": string, "notes": string, "greek_loans": string[], "neologisms": string[]}';
  const out = await env.AI.run(WORKERS_AI_MODEL, {
    messages: [
      { role: "system", content: `${systemPrompt(req)}\n${schemaHint}` },
      { role: "user", content: req.text },
    ],
    max_tokens: 6000,
    reasoning_effort: "low",
    response_format: { type: "json_object" },
  });
  const content = out?.choices?.[0]?.message?.content ?? out?.response;
  const data = typeof content === "object" && content ? content : parseJsonLoose(content);
  if (!data) throw new ProviderError("The Workers AI model returned no parsable JSON", { code: "bad_json" });
  return { data, provider: "workers-ai", model: WORKERS_AI_MODEL };
}

// Claude spends Cloudflare credits, so when CLAUDE_ACCESS_KEY is set only requests that
// carry it (header x-access-key) may use Claude; everyone else gets Workers AI.
async function sha256(s) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
}
async function claudeUnlocked(env, given) {
  if (!env.CLAUDE_ACCESS_KEY) return true;
  if (typeof given !== "string" || !given) return false;
  return crypto.subtle.timingSafeEqual(await sha256(given), await sha256(env.CLAUDE_ACCESS_KEY));
}

async function translate(env, req) {
  const attempts = [];
  const configured = env.CLAUDE_GATEWAY_TOKEN && env.CF_ACCOUNT_ID;
  let wantClaude = req.provider !== "workers-ai" && configured;
  if (wantClaude && !(await claudeUnlocked(env, req.accessKey))) {
    attempts.push({ provider: "claude", error: "Claude needs the access key (Translate → Claude access)", code: "locked" });
    wantClaude = false;
  }
  if (wantClaude) {
    try {
      return { ...(await translateClaude(env, req)), attempts };
    } catch (e) {
      attempts.push({ provider: "claude", error: e.message, code: e.code });
      if (req.provider === "claude") throw Object.assign(e, { attempts });
    }
  }
  return { ...(await translateWorkersAI(env, req)), attempts };
}

function cleanTranslation(data, direction) {
  const str = (v) => (typeof v === "string" ? v : "");
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 50) : []);
  if (direction === "la-en") return { english: str(data.english), notes: str(data.notes) };
  return { latin: str(data.latin), notes: str(data.notes), greek_loans: arr(data.greek_loans), neologisms: arr(data.neologisms) };
}

// ------------------------------------------------------------------ handlers

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

async function rateLimited(limiter, request) {
  if (!limiter) return false;
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const { success } = await limiter.limit({ key: ip });
  return !success;
}

const CONVERT_OPTION_KEYS = ["elision", "shortU", "lyricMacrons", "stressCaps", "ipaFinalM", "mode"];

async function handleConvert(request, env, url) {
  let text, options = {};
  if (request.method === "GET") {
    text = url.searchParams.get("text");
    for (const k of CONVERT_OPTION_KEYS) if (url.searchParams.has(k)) options[k] = url.searchParams.get(k);
    if (options.elision !== undefined) options.elision = options.elision === "1" || options.elision === "true";
    if (options.stressCaps !== undefined) options.stressCaps = !(options.stressCaps === "0" || options.stressCaps === "false");
  } else {
    const body = await readJson(request);
    text = body?.text;
    for (const k of CONVERT_OPTION_KEYS) if (body?.options && k in body.options) options[k] = body.options[k];
  }
  if (typeof text !== "string" || !text.trim()) return json({ error: "Send Latin text as `text`." }, 400);
  if (text.length > MAX_CONVERT_CHARS) return json({ error: `Text is limited to ${MAX_CONVERT_CHARS} characters.` }, 413);
  const entries = await lookup(env, url.origin, lookupKeys(text));
  const r = convert(text, { ...options, lexicon: lexiconFromEntries(entries) });
  if (url.searchParams.get("format") === "text") {
    const which = url.searchParams.get("output") || "hybrid";
    return new Response(r[which] ?? r.hybrid, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return json({
    hybrid: r.hybrid,
    lyric: r.lyric,
    respell: r.respell,
    ipa: r.ipa,
    words: r.words.map((w) => ({ word: w.word, form: w.form, source: w.source, syllables: syllableDisplay(w), notes: w.notes })),
  });
}

async function handleTranslate(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (await rateLimited(env.TRANSLATE_LIMIT, request)) return json({ error: "Too many translations; wait a minute." }, 429);
  const body = await readJson(request);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return json({ error: "Send the text to translate as `text`." }, 400);
  if (text.length > MAX_TRANSLATE_CHARS) return json({ error: `Translation is limited to ${MAX_TRANSLATE_CHARS} characters.` }, 413);
  const req = {
    text,
    direction: body.direction === "la-en" ? "la-en" : "en-la",
    style: body.style === "literal" ? "literal" : "lyrical",
    greek: !!body.greek,
    provider: ["claude", "workers-ai"].includes(body.provider) ? body.provider : "auto",
    accessKey: request.headers.get("x-access-key") || "",
  };
  try {
    const out = await translate(env, req);
    return json({ ...cleanTranslation(out.data, req.direction), direction: req.direction, provider: out.provider, model: out.model, attempts: out.attempts });
  } catch (e) {
    console.error(JSON.stringify({ event: "translate_failed", error: e.message, code: e.code, attempts: e.attempts }));
    return json({ error: e.message || "Translation failed", attempts: e.attempts ?? [] }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/health") {
        return json({
          ok: true,
          commit: env.COMMIT || "dev",
          translator: {
            claude: !!(env.CLAUDE_GATEWAY_TOKEN && env.CF_ACCOUNT_ID),
            claudeNeedsKey: !!env.CLAUDE_ACCESS_KEY,
            claudeModel: env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL,
            workersAiModel: WORKERS_AI_MODEL,
          },
        });
      }
      if (path === "/api/lookup") {
        if (request.method !== "POST") return json({ error: "POST only" }, 405);
        if (await rateLimited(env.LOOKUP_LIMIT, request)) return json({ error: "Too many requests" }, 429);
        const body = await readJson(request);
        const keys = Array.isArray(body?.keys) ? body.keys.slice(0, MAX_LOOKUP_KEYS) : [];
        return json({ entries: await lookup(env, url.origin, keys) });
      }
      if (path === "/api/convert") {
        if (await rateLimited(env.LOOKUP_LIMIT, request)) return json({ error: "Too many requests" }, 429);
        return await handleConvert(request, env, url);
      }
      if (path === "/api/translate") return await handleTranslate(request, env);
      if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error(JSON.stringify({ event: "unhandled", path, error: e.message, stack: e.stack }));
      return json({ error: "Internal error" }, 500);
    }
  },
};
