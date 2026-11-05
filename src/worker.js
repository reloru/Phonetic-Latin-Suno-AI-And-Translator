import Anthropic from "@anthropic-ai/sdk";
import { convert, lexiconFromEntries, lookupKeys, syllableDisplay } from "../public/js/engine.js";
import { shardOf } from "../public/js/lexkey.js";
import { systemPrompt, schemaFor, wrapInput, parseJsonLoose, cleanTranslation } from "../shared/prompts.js";
import manifest from "../public/lexicon/manifest.json" with { type: "json" };

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
      output_config: { effort: "medium", format: { type: "json_schema", schema: schemaFor(req.direction) } },
      system: systemPrompt(req),
      messages: [{ role: "user", content: wrapInput(req.text) }],
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

// The VM bridge: Relo's own machine runs the unmodified claude CLI on his subscription.
// It is reachable only over Cloudflare Tunnel and only with BRIDGE_SECRET, and it accepts
// nothing but these four fields, so it cannot be used as a general Claude proxy.
async function translateBridge(env, req) {
  const started = Date.now();
  try {
    const res = await fetch(`${env.BRIDGE_URL.replace(/\/$/, "")}/translate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.BRIDGE_SECRET}` },
      body: JSON.stringify({ text: req.text, direction: req.direction, style: req.style, greek: req.greek }),
      signal: AbortSignal.timeout(95_000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const busy = res.status === 503;
      throw new ProviderError(data?.error || `the VM bridge returned ${res.status}`, {
        status: res.status,
        code: busy ? "busy" : res.status === 401 ? "bridge_auth" : "bridge_error",
      });
    }
    if (!data) throw new ProviderError("the VM bridge returned no JSON", { code: "bad_json" });
    return { data, provider: "vm-bridge", model: data.model || "claude (VM)" };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    const timeout = e.name === "TimeoutError" || e.name === "AbortError";
    throw new ProviderError(
      timeout ? `the VM bridge did not answer within ${Math.round((Date.now() - started) / 1000)}s` : `the VM bridge is unreachable: ${e.message}`,
      { code: timeout ? "timeout" : "offline" },
    );
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
      { role: "user", content: wrapInput(req.text) },
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
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** Constant-time compare of two secrets, via their digests so lengths never differ. */
async function secretMatches(given, expected) {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function claudeUnlocked(env, given) {
  if (!env.CLAUDE_ACCESS_KEY) return true;
  if (typeof given !== "string" || !given) return false;
  return secretMatches(given, env.CLAUDE_ACCESS_KEY);
}

async function translate(env, req) {
  const attempts = [];
  const unlocked = await claudeUnlocked(env, req.accessKey);
  const have = {
    "vm-bridge": !!(env.BRIDGE_URL && env.BRIDGE_SECRET),
    claude: !!(env.CLAUDE_GATEWAY_TOKEN && env.CF_ACCOUNT_ID),
  };
  const runners = { "vm-bridge": translateBridge, claude: translateClaude };

  // Both Claude paths spend Relo's own resources, so both sit behind the access key.
  const wanted = req.provider === "auto" ? ["vm-bridge", "claude"] : req.provider === "workers-ai" ? [] : [req.provider];
  for (const name of wanted) {
    if (!have[name]) {
      if (req.provider !== "auto") attempts.push({ provider: name, error: `${name} is not configured`, code: "unconfigured" });
      continue;
    }
    if (!unlocked) {
      attempts.push({ provider: name, error: "this path needs the access key (Translate → Claude access)", code: "locked" });
      continue;
    }
    try {
      return { ...(await runners[name](env, req)), attempts };
    } catch (e) {
      attempts.push({ provider: name, error: e.message, code: e.code });
      if (req.provider === name) throw Object.assign(e, { attempts });
    }
  }
  return { ...(await translateWorkersAI(env, req)), attempts };
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
    provider: ["claude", "workers-ai", "vm-bridge"].includes(body.provider) ? body.provider : "auto",
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
            vmBridge: !!(env.BRIDGE_URL && env.BRIDGE_SECRET),
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
