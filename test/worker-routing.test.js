import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

const KEY = "test-access-key-0123456789";
const BASE_ENV = {
  BRIDGE_URL: "https://bridge.example",
  BRIDGE_SECRET: "bridge-secret-0123456789",
  CLAUDE_ACCESS_KEY: KEY,
  ASSETS: { fetch: async () => new Response("{}", { status: 200 }) },
  AI: {
    run: async () => ({ choices: [{ message: { content: JSON.stringify({ latin: "fallback", notes: "", greek_loans: [], neologisms: [] }) } }] }),
  },
};

/** Runs one /api/translate request with globalThis.fetch stubbed, recording bridge calls. */
async function translate({ key, env = {}, bridge = { ok: true } } = {}) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.authorization, body: JSON.parse(init.body) });
    if (bridge.throws) throw new Error("connection refused");
    if (!bridge.ok) return new Response(JSON.stringify({ error: "bridge is busy" }), { status: bridge.status ?? 503 });
    return new Response(JSON.stringify({ latin: "Hīc sum", notes: "", greek_loans: [], neologisms: [], model: "claude-opus-5" }), { status: 200 });
  };
  try {
    const res = await worker.fetch(
      new Request("https://x/api/translate", {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { "x-access-key": key } : {}) },
        body: JSON.stringify({ text: "I am here", direction: "en-la" }),
      }),
      { ...BASE_ENV, ...env },
    );
    return { status: res.status, body: await res.json(), calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("without the access key the VM bridge is never called", async () => {
  const { body, calls } = await translate({ key: null });
  assert.equal(calls.length, 0, "the bridge must not be contacted");
  assert.equal(body.provider, "workers-ai");
  assert.equal(body.latin, "fallback");
  assert.ok(body.attempts.some((a) => a.provider === "vm-bridge" && a.code === "locked"));
});

test("a wrong access key does not unlock the bridge", async () => {
  const { calls, body } = await translate({ key: "wrong-key-wrong-key-wrong" });
  assert.equal(calls.length, 0);
  assert.equal(body.provider, "workers-ai");
});

test("the correct access key routes to the bridge with its own secret", async () => {
  const { body, calls } = await translate({ key: KEY });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://bridge.example/translate");
  assert.equal(calls[0].auth, "Bearer bridge-secret-0123456789");
  assert.equal(calls[0].body.text, "I am here");
  assert.equal(body.provider, "vm-bridge");
  assert.equal(body.latin, "Hīc sum");
});

test("a bridge that is down or busy falls back to Workers AI", async () => {
  for (const bridge of [{ ok: false, status: 503 }, { throws: true }]) {
    const { body } = await translate({ key: KEY, bridge });
    assert.equal(body.provider, "workers-ai");
    assert.ok(body.attempts.some((a) => a.provider === "vm-bridge"));
  }
});

test("with no bridge configured the request still succeeds", async () => {
  const { body, calls } = await translate({ key: KEY, env: { BRIDGE_URL: "", BRIDGE_SECRET: "" } });
  assert.equal(calls.length, 0);
  assert.equal(body.provider, "workers-ai");
});

test("health reports which translators are configured", async () => {
  const res = await worker.fetch(new Request("https://x/api/health"), BASE_ENV);
  const body = await res.json();
  assert.equal(body.translator.vmBridge, true);
  assert.equal(body.translator.claudeNeedsKey, true);
});
