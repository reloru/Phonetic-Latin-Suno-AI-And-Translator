#!/usr/bin/env node
// Latin translation bridge.
//
// Runs on Relo's VM and exposes ONE operation: translate text by spawning the unmodified
// `claude` CLI, which authenticates with his own Claude subscription. The Worker calls it
// with a shared secret. It is deliberately not a general Claude proxy: the caller supplies
// text and three flags, never a prompt, a model or a command.
//
// Safety properties, each verified by test/bridge.test.js or the canary in bridge/README.md:
//   - every tool is denied, so the spawned agent has no Bash, file or network access
//   - the CLI is spawned without a shell, with the text written to stdin, never argv
//   - it runs in an empty working directory, with one request at a time and a hard timeout
//   - it listens on 127.0.0.1 only; Cloudflare Tunnel is the only way in

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual, createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { systemPrompt, wrapInput, parseJsonLoose, cleanTranslation } from "../shared/prompts.js";
import { lockdownSettings, claudeArgs, childEnv } from "./lockdown.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BRIDGE_PORT || 8790);
const SECRET = process.env.BRIDGE_SECRET || "";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "/usr/bin/claude";
const WORK_DIR = process.env.BRIDGE_WORK_DIR || join(HERE, "work");
const SETTINGS = join(HERE, "claude-settings.json");
const TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS || 90_000);
const MAX_BODY = 16 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const MAX_TEXT = 4000;

if (!SECRET || SECRET.length < 16) {
  console.error("BRIDGE_SECRET is missing or too short; refusing to start");
  process.exit(1);
}
mkdirSync(WORK_DIR, { recursive: true });

writeFileSync(SETTINGS, JSON.stringify(lockdownSettings()));

const sha = (s) => createHash("sha256").update(String(s)).digest();
const secretOk = (given) => {
  try { return timingSafeEqual(sha(given), sha(SECRET)); } catch { return false; }
};

let busy = false;
let served = 0;

/** Spawns the claude CLI for one translation. Resolves with its parsed JSON reply. */
function runClaude({ text, direction, style, greek }) {
  return new Promise((resolve, reject) => {
    const args = claudeArgs({ settingsPath: SETTINGS, system: systemPrompt({ direction, style, greek }) });
    const child = spawn(CLAUDE_BIN, args, { cwd: WORK_DIR, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });

    let out = "";
    let err = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => {
      out += d;
      if (out.length > MAX_OUTPUT) { killed = true; child.kill("SIGKILL"); }
    });
    child.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`cannot start claude: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error(`claude timed out after ${TIMEOUT_MS / 1000}s`));
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(-300)}`));

      let events;
      try { events = JSON.parse(out); } catch { return reject(new Error("claude returned no JSON")); }
      const list = Array.isArray(events) ? events : [events];
      const result = list.find((e) => e && e.type === "result") || (Array.isArray(events) ? null : events);
      if (!result) return reject(new Error("claude returned no result event"));
      if (result.is_error) return reject(new Error(`claude reported an error: ${String(result.result).slice(0, 200)}`));
      const data = parseJsonLoose(result.result);
      if (!data) return reject(new Error("the translation was not valid JSON"));
      resolve({ data, model: result.model || list.find((e) => e?.model)?.model || "claude", durationMs: result.duration_ms });
    });

    child.stdin.on("error", () => {});
    child.stdin.end(wrapInput(text));
  });
}

const send = (res, status, body) => {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(s);
};

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, busy, served, timeoutMs: TIMEOUT_MS });
  }
  if (req.method !== "POST" || url.pathname !== "/translate") {
    return send(res, 404, { error: "not found" });
  }
  if (!secretOk(req.headers.authorization?.replace(/^Bearer\s+/i, "") || "")) {
    return send(res, 401, { error: "unauthorized" });
  }
  if (busy) return send(res, 503, { error: "the bridge is already running a translation" });

  let body = "";
  let tooBig = false;
  req.on("data", (c) => {
    body += c;
    if (body.length > MAX_BODY && !tooBig) { tooBig = true; send(res, 413, { error: "body too large" }); req.destroy(); }
  });
  req.on("end", async () => {
    if (tooBig) return;
    let parsed;
    try { parsed = JSON.parse(body); } catch { return send(res, 400, { error: "invalid JSON body" }); }
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (!text) return send(res, 400, { error: "`text` is required" });
    if (text.length > MAX_TEXT) return send(res, 413, { error: `text is limited to ${MAX_TEXT} characters` });
    const direction = parsed.direction === "la-en" ? "la-en" : "en-la";

    busy = true;
    const started = Date.now();
    try {
      const { data, model, durationMs } = await runClaude({
        text,
        direction,
        style: parsed.style === "literal" ? "literal" : "lyrical",
        greek: !!parsed.greek,
      });
      served++;
      // Log shape only: never the text being translated.
      console.log(JSON.stringify({ event: "translated", direction, chars: text.length, ms: Date.now() - started, model }));
      send(res, 200, { ...cleanTranslation(data, direction), direction, provider: "vm-bridge", model, durationMs });
    } catch (e) {
      console.error(JSON.stringify({ event: "failed", direction, chars: text.length, ms: Date.now() - started, error: e.message }));
      send(res, 502, { error: e.message });
    } finally {
      busy = false;
    }
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(JSON.stringify({ event: "listening", port: PORT, workDir: WORK_DIR })));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
