import { spawn, type Subprocess } from "bun";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Env migration: deprecated CLAWDBOT_* → OPENCLAW_*
// ---------------------------------------------------------------------------
for (const suffix of ["PUBLIC_PORT", "STATE_DIR", "WORKSPACE_DIR", "GATEWAY_TOKEN", "CONFIG_PATH"]) {
  const oldKey = `CLAWDBOT_${suffix}`;
  const newKey = `OPENCLAW_${suffix}`;
  if (process.env[oldKey] && !process.env[newKey]) {
    process.env[newKey] = process.env[oldKey];
  }
  delete process.env[oldKey];
}

// ---------------------------------------------------------------------------
// Config constants
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT ?? process.env.OPENCLAW_PUBLIC_PORT ?? "3000", 10);

const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");

const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

function resolveGatewayToken(): string {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch { /* ignore */ }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch { /* best-effort */ }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

const INTERNAL_GATEWAY_PORT = parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

// ---------------------------------------------------------------------------
// GitHub Webhook Proxy config
// ---------------------------------------------------------------------------
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";
const GITHUB_APP_ID = process.env.GITHUB_APP_ID || "";
const GITHUB_INSTALLATION_ID = process.env.GITHUB_INSTALLATION_ID || "";
const GITHUB_APP_PEM_PATH = process.env.GITHUB_APP_PEM_PATH || "";
const OPENCLAW_HOOKS_URL = process.env.OPENCLAW_HOOKS_URL || `${GATEWAY_TARGET}/hooks/github`;
const OPENCLAW_HOOKS_TOKEN = process.env.OPENCLAW_HOOKS_TOKEN || "";

let ghCachedToken: string | null = null;
let ghTokenExpiry = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function clawArgs(args: string[]): string[] {
  return [OPENCLAW_ENTRY, ...args];
}

function resolveConfigCandidates(): string[] {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) return [explicit];
  return [path.join(STATE_DIR, "openclaw.json")];
}

function configPath(): string {
  const candidates = resolveConfigCandidates();
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return candidates[0] || path.join(STATE_DIR, "openclaw.json");
}

function isConfigured(): boolean {
  try {
    return resolveConfigCandidates().some((c) => fs.existsSync(c));
  } catch { return false; }
}

// Legacy config migration
(function migrateLegacyConfigFile() {
  if (process.env.OPENCLAW_CONFIG_PATH?.trim()) return;
  const canonical = path.join(STATE_DIR, "openclaw.json");
  if (fs.existsSync(canonical)) return;
  for (const legacy of ["clawdbot.json", "moltbot.json"]) {
    const legacyPath = path.join(STATE_DIR, legacy);
    try {
      if (fs.existsSync(legacyPath)) {
        fs.renameSync(legacyPath, canonical);
        console.log(`[migration] Renamed ${legacy} → openclaw.json`);
        return;
      }
    } catch (err) {
      console.warn(`[migration] Failed to rename ${legacy}: ${err}`);
    }
  }
})();

// ---------------------------------------------------------------------------
// Gateway process management
// ---------------------------------------------------------------------------
let gatewayProc: Subprocess | null = null;
let gatewayStarting: Promise<void> | null = null;

let lastGatewayError: string | null = null;
let lastGatewayExit: { code: number | null; signal: string | null; at: string } | null = null;
let lastDoctorOutput: string | null = null;
let lastDoctorAt: number | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts: { timeoutMs?: number } = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      for (const p of ["/openclaw", "/"]) {
        try {
          const res = await fetch(`${GATEWAY_TARGET}${p}`, { method: "GET" });
          if (res) return true;
        } catch { /* try next */ }
      }
    } catch { /* not ready */ }
    await sleep(250);
  }
  return false;
}

async function startGateway(): Promise<void> {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const args = [
    "gateway", "run",
    "--bind", "loopback",
    "--port", String(INTERNAL_GATEWAY_PORT),
    "--auth", "token",
    "--token", OPENCLAW_GATEWAY_TOKEN,
  ];

  const proc = spawn([OPENCLAW_NODE, ...clawArgs(args)], {
    stdio: ["inherit", "inherit", "inherit"],
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  gatewayProc = proc;

  // Monitor exit in background
  proc.exited.then((code) => {
    const msg = `[gateway] exited code=${code}`;
    console.error(msg);
    lastGatewayExit = { code, signal: null, at: new Date().toISOString() };
    if (gatewayProc === proc) gatewayProc = null;
  }).catch((err) => {
    const msg = `[gateway] error: ${String(err)}`;
    console.error(msg);
    lastGatewayError = msg;
    if (gatewayProc === proc) gatewayProc = null;
  });
}

interface RunCmdResult {
  code: number;
  output: string;
}

async function runCmd(cmd: string, args: string[], opts: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<RunCmdResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const proc = spawn([cmd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      ...opts.env,
    },
  });

  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    try { proc.kill(); } catch { /* ignore */ }
  }, timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const code = await proc.exited;
  clearTimeout(timer);

  let output = stdout + stderr;
  if (killed) output += `\n[timeout] Command exceeded ${timeoutMs}ms and was terminated.\n`;

  return { code: code ?? 0, output };
}

async function runDoctorBestEffort(): Promise<void> {
  const now = Date.now();
  if (lastDoctorAt && now - lastDoctorAt < 5 * 60 * 1000) return;
  lastDoctorAt = now;
  try {
    const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
    const out = redactSecrets(r.output || "");
    lastDoctorOutput = out.length > 50_000 ? out.slice(0, 50_000) + "\n... (truncated)\n" : out;
  } catch (err) {
    lastDoctorOutput = `doctor failed: ${String(err)}`;
  }
}

async function ensureGatewayRunning(): Promise<{ ok: boolean; reason?: string }> {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      try {
        lastGatewayError = null;
        await startGateway();
        const ready = await waitForGatewayReady({ timeoutMs: 20_000 });
        if (!ready) throw new Error("Gateway did not become ready in time");
      } catch (err) {
        lastGatewayError = `[gateway] start failure: ${String(err)}`;
        await runDoctorBestEffort();
        throw err;
      }
    })().finally(() => { gatewayStarting = null; });
  }
  await gatewayStarting;
  return { ok: true };
}

async function restartGateway(): Promise<{ ok: boolean; reason?: string }> {
  if (gatewayProc) {
    try { gatewayProc.kill(); } catch { /* ignore */ }
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function checkBasicAuth(req: Request): Response | null {
  if (!SETUP_PASSWORD) {
    return new Response("SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.", { status: 500 });
  }
  const header = req.headers.get("authorization") || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    return new Response("Auth required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="OpenClaw Setup"' },
    });
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (password !== SETUP_PASSWORD) {
    return new Response("Invalid password", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="OpenClaw Setup"' },
    });
  }
  return null; // auth OK
}

// ---------------------------------------------------------------------------
// Redaction & utilities
// ---------------------------------------------------------------------------
function redactSecrets(text: string): string {
  if (!text) return text;
  return String(text)
    .replace(/(sk-[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(gho_[A-Za-z0-9_]{10,})/g, "[REDACTED]")
    .replace(/(xox[baprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]")
    .replace(/(\d{5,}:[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(AA[A-Za-z0-9_-]{10,}:\S{10,})/g, "[REDACTED]");
}

function extractDeviceRequestIds(text: string): string[] {
  const s = String(text || "");
  const out = new Set<string>();
  for (const m of s.matchAll(/requestId\s*(?:=|:)\s*([A-Za-z0-9_-]{6,})/g)) out.add(m[1]);
  for (const m of s.matchAll(/"requestId"\s*:\s*"([A-Za-z0-9_-]{6,})"/g)) out.add(m[1]);
  return Array.from(out);
}

// ---------------------------------------------------------------------------
// Auth groups (provider list for setup wizard)
// ---------------------------------------------------------------------------
const AUTH_GROUPS = [
  { value: "openai", label: "OpenAI", hint: "Codex OAuth + API key", options: [
    { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
    { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
    { value: "openai-api-key", label: "OpenAI API key" }
  ]},
  { value: "anthropic", label: "Anthropic", hint: "Claude Code CLI + API key", options: [
    { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
    { value: "token", label: "Anthropic token (paste setup-token)" },
    { value: "apiKey", label: "Anthropic API key" }
  ]},
  { value: "google", label: "Google", hint: "Gemini API key + OAuth", options: [
    { value: "gemini-api-key", label: "Google Gemini API key" },
    { value: "google-antigravity", label: "Google Antigravity OAuth" },
    { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" }
  ]},
  { value: "openrouter", label: "OpenRouter", hint: "API key", options: [
    { value: "openrouter-api-key", label: "OpenRouter API key" }
  ]},
  { value: "ai-gateway", label: "Vercel AI Gateway", hint: "API key", options: [
    { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" }
  ]},
  { value: "moonshot", label: "Moonshot AI", hint: "Kimi K2 + Kimi Code", options: [
    { value: "moonshot-api-key", label: "Moonshot AI API key" },
    { value: "kimi-code-api-key", label: "Kimi Code API key" }
  ]},
  { value: "zai", label: "Z.AI (GLM 4.7)", hint: "API key", options: [
    { value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }
  ]},
  { value: "minimax", label: "MiniMax", hint: "M2.1 (recommended)", options: [
    { value: "minimax-api", label: "MiniMax M2.1" },
    { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" }
  ]},
  { value: "qwen", label: "Qwen", hint: "OAuth", options: [
    { value: "qwen-portal", label: "Qwen OAuth" }
  ]},
  { value: "copilot", label: "Copilot", hint: "GitHub + local proxy", options: [
    { value: "github-copilot", label: "GitHub Copilot (GitHub device login)" },
    { value: "copilot-proxy", label: "Copilot Proxy (local)" }
  ]},
  { value: "synthetic", label: "Synthetic", hint: "Anthropic-compatible (multi-model)", options: [
    { value: "synthetic-api-key", label: "Synthetic API key" }
  ]},
  { value: "opencode-zen", label: "OpenCode Zen", hint: "API key", options: [
    { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" }
  ]}
];

// ---------------------------------------------------------------------------
// Console commands allowlist
// ---------------------------------------------------------------------------
const ALLOWED_CONSOLE_COMMANDS = new Set([
  "gateway.restart", "gateway.stop", "gateway.start",
  "openclaw.version", "openclaw.status", "openclaw.health", "openclaw.doctor",
  "openclaw.logs.tail", "openclaw.config.get",
  "openclaw.devices.list", "openclaw.devices.approve",
  "openclaw.plugins.list", "openclaw.plugins.enable",
]);

// ---------------------------------------------------------------------------
// Onboard args builder
// ---------------------------------------------------------------------------
function buildOnboardArgs(payload: Record<string, any>): string[] {
  const args = [
    "onboard", "--non-interactive", "--accept-risk", "--json",
    "--no-install-daemon", "--skip-health",
    "--workspace", WORKSPACE_DIR,
    "--gateway-bind", "loopback",
    "--gateway-port", String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth", "token",
    "--gateway-token", OPENCLAW_GATEWAY_TOKEN,
    "--flow", payload.flow || "quickstart",
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);
    const secret = (payload.authSecret || "").trim();
    const map: Record<string, string> = {
      "openai-api-key": "--openai-api-key",
      "apiKey": "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key",
    };
    const flag = map[payload.authChoice];
    if (flag && !secret) throw new Error(`Missing auth secret for authChoice=${payload.authChoice}`);
    if (flag) args.push(flag, secret);
    if (payload.authChoice === "token") {
      if (!secret) throw new Error("Missing auth secret for authChoice=token");
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// GitHub Webhook Proxy helpers
// ---------------------------------------------------------------------------
function makeGitHubJWT(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: GITHUB_APP_ID })).toString("base64url");
  const key = crypto.createPrivateKey(fs.readFileSync(GITHUB_APP_PEM_PATH, "utf8"));
  const sig = crypto.createSign("SHA256").update(`${header}.${payload}`).sign(key, "base64url");
  return `${header}.${payload}.${sig}`;
}

async function getGitHubToken(): Promise<string> {
  if (ghCachedToken && Date.now() < ghTokenExpiry) return ghCachedToken;
  const jwt = makeGitHubJWT();
  const r = await fetch(`https://api.github.com/app/installations/${GITHUB_INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
  });
  const d = await r.json() as { token: string };
  ghCachedToken = d.token;
  ghTokenExpiry = Date.now() + 55 * 60 * 1000;
  return ghCachedToken!;
}

async function addEyesReaction(payload: any, event: string): Promise<void> {
  try {
    const action = payload.action;
    let reactUrl: string | null = null;

    if ((event === "issues" || event === "issue_comment") && payload.issue) {
      if (action === "opened" || action === "assigned" || action === "created") {
        reactUrl = `${payload.issue.url}/reactions`;
      }
    } else if ((event === "pull_request" || event === "pull_request_review") && payload.pull_request) {
      if (action === "opened" || action === "assigned" || action === "submitted" || action === "review_requested") {
        reactUrl = `${payload.pull_request.issue_url}/reactions`;
      }
    }
    if (!reactUrl) return;

    const actor = payload.sender?.login || "";
    if (actor === "pax-openclaw[bot]") return;

    const token = await getGitHubToken();
    const r = await fetch(reactUrl, {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: "eyes" }),
    });
    console.log(`[${new Date().toISOString()}] 👀 reaction → ${r.status} (${reactUrl.split("/repos/")[1]})`);
  } catch (err: any) {
    console.error(`[${new Date().toISOString()}] 👀 reaction error: ${err.message}`);
  }
}

function verifyGitHubSignature(body: Buffer, signature: string | null): boolean {
  if (!GITHUB_WEBHOOK_SECRET) return true;
  if (!signature) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", GITHUB_WEBHOOK_SECRET).update(body).digest("hex");
  return signature === expected;
}

// ---------------------------------------------------------------------------
// Tar export/import helpers (using system tar via Bun.spawn)
// ---------------------------------------------------------------------------
async function tarCreate(cwd: string, paths: string[]): Promise<ReadableStream<Uint8Array>> {
  const proc = spawn(["tar", "czf", "-", "--no-same-owner", ...paths], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.stdout as ReadableStream<Uint8Array>;
}

async function tarExtract(cwd: string, archivePath: string): Promise<void> {
  const proc = spawn(["tar", "xzf", archivePath, "--no-same-owner"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`tar extract failed (code ${code}): ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Setup HTML page
// ---------------------------------------------------------------------------
const SETUP_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Setup</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 2rem; max-width: 900px; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 1.25rem; margin: 1rem 0; }
    label { display:block; margin-top: 0.75rem; font-weight: 600; }
    input, select { width: 100%; padding: 0.6rem; margin-top: 0.25rem; }
    button { padding: 0.8rem 1.2rem; border-radius: 10px; border: 0; background: #111; color: #fff; font-weight: 700; cursor: pointer; }
    code { background: #f6f6f6; padding: 0.1rem 0.3rem; border-radius: 6px; }
    .muted { color: #555; }
  </style>
</head>
<body>
  <h1>OpenClaw Setup</h1>
  <p class="muted">This wizard configures OpenClaw by running the same onboarding command it uses in the terminal, but from the browser.</p>

  <div class="card">
    <h2>Status</h2>
    <div id="status">Loading...</div>
    <div id="statusDetails" class="muted" style="margin-top:0.5rem"></div>
    <div style="margin-top: 0.75rem">
      <a href="/openclaw" target="_blank">Open OpenClaw UI</a>
      &nbsp;|&nbsp;
      <a href="/setup/export" target="_blank">Download backup (.tar.gz)</a>
    </div>

    <div style="margin-top: 0.75rem">
      <div class="muted" style="margin-bottom:0.25rem"><strong>Import backup</strong> (advanced): restores into <code>/data</code> and restarts the gateway.</div>
      <input id="importFile" type="file" accept=".tar.gz,application/gzip" />
      <button id="importRun" style="background:#7c2d12; margin-top:0.5rem">Import</button>
      <pre id="importOut" style="white-space:pre-wrap"></pre>
    </div>
  </div>

  <div class="card">
    <h2>Debug console</h2>
    <p class="muted">Run a small allowlist of safe commands (no shell). Useful for debugging and recovery.</p>

    <div style="display:flex; gap:0.5rem; align-items:center">
      <select id="consoleCmd" style="flex: 1">
        <option value="gateway.restart">gateway.restart (wrapper-managed)</option>
        <option value="gateway.stop">gateway.stop (wrapper-managed)</option>
        <option value="gateway.start">gateway.start (wrapper-managed)</option>
        <option value="openclaw.status">openclaw status</option>
        <option value="openclaw.health">openclaw health</option>
        <option value="openclaw.doctor">openclaw doctor</option>
        <option value="openclaw.logs.tail">openclaw logs --tail N</option>
        <option value="openclaw.config.get">openclaw config get &lt;path&gt;</option>
        <option value="openclaw.version">openclaw --version</option>
        <option value="openclaw.devices.list">openclaw devices list</option>
        <option value="openclaw.devices.approve">openclaw devices approve &lt;requestId&gt;</option>
        <option value="openclaw.plugins.list">openclaw plugins list</option>
        <option value="openclaw.plugins.enable">openclaw plugins enable &lt;name&gt;</option>
      </select>
      <input id="consoleArg" placeholder="Optional arg (e.g. 200, gateway.port)" style="flex: 1" />
      <button id="consoleRun" style="background:#0f172a">Run</button>
    </div>
    <pre id="consoleOut" style="white-space:pre-wrap"></pre>
  </div>

  <div class="card">
    <h2>Config editor (advanced)</h2>
    <p class="muted">Edits the full config file on disk (JSON5). Saving creates a timestamped <code>.bak-*</code> backup and restarts the gateway.</p>
    <div class="muted" id="configPath"></div>
    <textarea id="configText" style="width:100%; height: 260px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;"></textarea>
    <div style="margin-top:0.5rem">
      <button id="configReload" style="background:#1f2937">Reload</button>
      <button id="configSave" style="background:#111; margin-left:0.5rem">Save</button>
    </div>
    <pre id="configOut" style="white-space:pre-wrap"></pre>
  </div>

  <div class="card">
    <h2>1) Model/auth provider</h2>
    <p class="muted">Matches the groups shown in the terminal onboarding.</p>
    <label>Provider group</label>
    <select id="authGroup">
      <option>Loading providers…</option>
    </select>

    <label>Auth method</label>
    <select id="authChoice">
      <option>Loading methods…</option>
    </select>

    <label>Key / Token (if required)</label>
    <input id="authSecret" type="password" placeholder="Paste API key / token if applicable" />

    <label>Wizard flow</label>
    <select id="flow">
      <option value="quickstart">quickstart</option>
      <option value="advanced">advanced</option>
      <option value="manual">manual</option>
    </select>
  </div>

  <div class="card">
    <h2>2) Optional: Channels</h2>
    <p class="muted">You can also add channels later inside OpenClaw, but this helps you get messaging working immediately.</p>

    <label>Telegram bot token (optional)</label>
    <input id="telegramToken" type="password" placeholder="123456:ABC..." />
    <div class="muted" style="margin-top: 0.25rem">
      Get it from BotFather: open Telegram, message <code>@BotFather</code>, run <code>/newbot</code>, then copy the token.
    </div>

    <label>Discord bot token (optional)</label>
    <input id="discordToken" type="password" placeholder="Bot token" />
    <div class="muted" style="margin-top: 0.25rem">
      Get it from the Discord Developer Portal: create an application, add a Bot, then copy the Bot Token.<br/>
      <strong>Important:</strong> Enable <strong>MESSAGE CONTENT INTENT</strong> in Bot → Privileged Gateway Intents, or the bot will crash on startup.
    </div>

    <label>Slack bot token (optional)</label>
    <input id="slackBotToken" type="password" placeholder="xoxb-..." />

    <label>Slack app token (optional)</label>
    <input id="slackAppToken" type="password" placeholder="xapp-..." />
  </div>

  <div class="card">
    <h2>2b) Advanced: Custom OpenAI-compatible provider (optional)</h2>
    <p class="muted">Use this to configure an OpenAI-compatible API that requires a custom base URL (e.g. Ollama, vLLM, LM Studio, hosted proxies). You usually set the API key as a Railway variable and reference it here.</p>

    <label>Provider id (e.g. ollama, deepseek, myproxy)</label>
    <input id="customProviderId" placeholder="ollama" />

    <label>Base URL (must include /v1, e.g. http://host:11434/v1)</label>
    <input id="customProviderBaseUrl" placeholder="http://127.0.0.1:11434/v1" />

    <label>API (openai-completions or openai-responses)</label>
    <select id="customProviderApi">
      <option value="openai-completions">openai-completions</option>
      <option value="openai-responses">openai-responses</option>
    </select>

    <label>API key env var name (optional, e.g. OLLAMA_API_KEY). Leave blank for no key.</label>
    <input id="customProviderApiKeyEnv" placeholder="OLLAMA_API_KEY" />

    <label>Optional model id to register (e.g. llama3.1:8b)</label>
    <input id="customProviderModelId" placeholder="" />
  </div>

  <div class="card">
    <h2>3) Run onboarding</h2>
    <button id="run">Run setup</button>
    <button id="pairingApprove" style="background:#1f2937; margin-left:0.5rem">Approve pairing</button>
    <button id="reset" style="background:#444; margin-left:0.5rem">Reset setup</button>
    <pre id="log" style="white-space:pre-wrap"></pre>
    <p class="muted">Reset deletes the OpenClaw config file so you can rerun onboarding. Pairing approval lets you grant DM access when dmPolicy=pairing.</p>

    <details style="margin-top: 0.75rem">
      <summary><strong>Pairing helper</strong> (for "disconnected (1008): pairing required")</summary>
      <p class="muted">This lists pending device requests and lets you approve them without SSH.</p>
      <button id="devicesRefresh" style="background:#0f172a">Refresh pending devices</button>
      <div id="devicesList" class="muted" style="margin-top:0.5rem"></div>
    </details>
  </div>

  <script src="/setup/app.js"></script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------
async function probeGateway(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({
      host: INTERNAL_GATEWAY_HOST,
      port: INTERNAL_GATEWAY_PORT,
      timeout: 750,
    });
    const done = (ok: boolean) => {
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

function json(data: any, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function isUnderDir(p: string, root: string): boolean {
  const abs = path.resolve(p);
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  // Health endpoints (no auth)
  if (method === "GET" && pathname === "/setup/healthz") {
    return json({ ok: true });
  }

  if (method === "GET" && pathname === "/healthz") {
    let gatewayReachable = false;
    if (isConfigured()) {
      try { gatewayReachable = await probeGateway(); } catch { /* ignore */ }
    }
    return json({
      ok: true,
      wrapper: { configured: isConfigured(), stateDir: STATE_DIR, workspaceDir: WORKSPACE_DIR },
      gateway: {
        target: GATEWAY_TARGET, reachable: gatewayReachable,
        lastError: lastGatewayError, lastExit: lastGatewayExit, lastDoctorAt,
      },
    });
  }

  // GitHub webhook endpoint (no setup auth, uses HMAC)
  if (method === "POST" && pathname === "/github/webhook") {
    return handleGitHubWebhook(req);
  }

  // --- Setup routes (require basic auth) ---
  if (pathname.startsWith("/setup")) {
    const authErr = checkBasicAuth(req);
    if (authErr) return authErr;

    if (method === "GET" && pathname === "/setup") return html(SETUP_HTML);
    if (method === "GET" && pathname === "/setup/app.js") {
      const js = fs.readFileSync(path.join(process.cwd(), "src", "setup-app.js"), "utf8");
      return new Response(js, { headers: { "Content-Type": "application/javascript" } });
    }
    if (method === "GET" && pathname === "/setup/api/status") return handleSetupStatus();
    if (method === "GET" && pathname === "/setup/api/auth-groups") return json({ ok: true, authGroups: AUTH_GROUPS });
    if (method === "POST" && pathname === "/setup/api/run") return handleSetupRun(req);
    if (method === "GET" && pathname === "/setup/api/debug") return handleSetupDebug();
    if (method === "POST" && pathname === "/setup/api/console/run") return handleConsoleRun(req);
    if (method === "GET" && pathname === "/setup/api/config/raw") return handleConfigGet();
    if (method === "POST" && pathname === "/setup/api/config/raw") return handleConfigSave(req);
    if (method === "POST" && pathname === "/setup/api/pairing/approve") return handlePairingApprove(req);
    if (method === "GET" && pathname === "/setup/api/devices/pending") return handleDevicesPending();
    if (method === "POST" && pathname === "/setup/api/devices/approve") return handleDevicesApprove(req);
    if (method === "POST" && pathname === "/setup/api/reset") return handleReset();
    if (method === "GET" && pathname === "/setup/export") return handleExport();
    if (method === "POST" && pathname === "/setup/import") return handleImport(req);
  }

  // --- Proxy to gateway ---
  if (!isConfigured() && !pathname.startsWith("/setup")) {
    return Response.redirect("/setup", 302);
  }

  if (isConfigured()) {
    try {
      await ensureGatewayRunning();
    } catch (err) {
      const hint = [
        "Gateway not ready.", String(err),
        lastGatewayError ? `\n${lastGatewayError}` : "",
        "\nTroubleshooting:",
        "- Visit /setup and check the Debug Console",
        "- Visit /setup/api/debug for config + gateway diagnostics",
      ].join("\n");
      return text(hint, 503);
    }
  }

  return proxyToGateway(req);
}

// ---------------------------------------------------------------------------
// GitHub Webhook handler
// ---------------------------------------------------------------------------
async function handleGitHubWebhook(req: Request): Promise<Response> {
  const body = Buffer.from(await req.arrayBuffer());

  if (GITHUB_WEBHOOK_SECRET && !verifyGitHubSignature(body, req.headers.get("x-hub-signature-256"))) {
    console.log(`[${new Date().toISOString()}] ✗ HMAC verification failed`);
    return text("Forbidden", 403);
  }

  const event = req.headers.get("x-github-event") || "unknown";
  const delivery = req.headers.get("x-github-delivery") || "";
  console.log(`[${new Date().toISOString()}] ← ${event} (${delivery.slice(0, 8)}…)`);

  // Instant 👀 reaction (fire-and-forget)
  let payload: any;
  try { payload = JSON.parse(body.toString()); } catch { /* ignore */ }
  if (payload && GITHUB_APP_ID && GITHUB_INSTALLATION_ID && GITHUB_APP_PEM_PATH) {
    addEyesReaction(payload, event);
  }

  // Forward to OpenClaw hooks
  try {
    const resp = await fetch(OPENCLAW_HOOKS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENCLAW_HOOKS_TOKEN}`,
        "X-GitHub-Event": event,
        "X-GitHub-Delivery": delivery,
      },
      body,
    });
    const respText = await resp.text();
    console.log(`[${new Date().toISOString()}] → ${resp.status} ${respText.slice(0, 120)}`);
    return new Response(respText, { status: resp.status, headers: { "Content-Type": "application/json" } });
  } catch (err: any) {
    console.error(`[${new Date().toISOString()}] ✗ Forward error: ${err.message}`);
    return json({ error: "proxy error", detail: err.message }, 502);
  }
}

// ---------------------------------------------------------------------------
// Setup API handlers
// ---------------------------------------------------------------------------
async function handleSetupStatus(): Promise<Response> {
  const version = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
  return json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version.output.trim(),
    channelsAddHelp: channelsHelp.output,
    authGroups: AUTH_GROUPS,
  });
}

async function handleSetupRun(req: Request): Promise<Response> {
  try {
    if (isConfigured()) {
      await ensureGatewayRunning();
      return json({ ok: true, output: "Already configured.\nUse Reset setup if you want to rerun onboarding.\n" });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = (await req.json()) as Record<string, any>;

    let onboardArgs: string[];
    try {
      onboardArgs = buildOnboardArgs(payload);
    } catch (err) {
      return json({ ok: false, output: `Setup input error: ${String(err)}` }, 400);
    }

    const prefix = "[setup] running openclaw onboard...\n";
    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));
    let extra = "";
    const ok = onboard.code === 0 && isConfigured();

    if (ok) {
      // Post-onboard config
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.token", OPENCLAW_GATEWAY_TOKEN]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.bind", "loopback"]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.port", String(INTERNAL_GATEWAY_PORT)]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "gateway.trustedProxies", JSON.stringify(["127.0.0.1"])]));

      // Custom provider
      if (payload.customProviderId?.trim() && payload.customProviderBaseUrl?.trim()) {
        const providerId = payload.customProviderId.trim();
        const baseUrl = payload.customProviderBaseUrl.trim();
        const api = (payload.customProviderApi || "openai-completions").trim();
        const apiKeyEnv = (payload.customProviderApiKeyEnv || "").trim();
        const modelId = (payload.customProviderModelId || "").trim();

        if (!/^[A-Za-z0-9_-]+$/.test(providerId)) {
          extra += `\n[custom provider] skipped: invalid provider id`;
        } else if (!/^https?:\/\//.test(baseUrl)) {
          extra += `\n[custom provider] skipped: baseUrl must start with http(s)://`;
        } else if (api !== "openai-completions" && api !== "openai-responses") {
          extra += `\n[custom provider] skipped: api must be openai-completions or openai-responses`;
        } else if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
          extra += `\n[custom provider] skipped: invalid api key env var name`;
        } else {
          const providerCfg: Record<string, any> = { baseUrl, api };
          if (apiKeyEnv) providerCfg.apiKey = "${" + apiKeyEnv + "}";
          if (modelId) providerCfg.models = [{ id: modelId, name: modelId }];
          await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "models.mode", "merge"]));
          const set = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", `models.providers.${providerId}`, JSON.stringify(providerCfg)]));
          extra += `\n[custom provider] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        }
      }

      const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
      const helpText = channelsHelp.output || "";
      const supports = (name: string) => helpText.includes(name);

      // Telegram
      if (payload.telegramToken?.trim()) {
        if (!supports("telegram")) {
          extra += "\n[telegram] skipped (not supported)\n";
        } else {
          const cfgObj = { enabled: true, dmPolicy: "pairing", botToken: payload.telegramToken.trim(), groupPolicy: "allowlist", streamMode: "partial" };
          const set = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(cfgObj)]));
          const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));
          const plug = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", "telegram"]));
          extra += `\n[telegram config] exit=${set.code}\n${set.output || "(no output)"}`;
          extra += `\n[telegram verify] exit=${get.code}\n${get.output || "(no output)"}`;
          extra += `\n[telegram plugin enable] exit=${plug.code}\n${plug.output || "(no output)"}`;
        }
      }

      // Discord
      if (payload.discordToken?.trim()) {
        if (!supports("discord")) {
          extra += "\n[discord] skipped (not supported)\n";
        } else {
          const cfgObj = { enabled: true, token: payload.discordToken.trim(), groupPolicy: "allowlist", dm: { policy: "pairing" } };
          const set = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "channels.discord", JSON.stringify(cfgObj)]));
          const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));
          extra += `\n[discord config] exit=${set.code}\n${set.output || "(no output)"}`;
          extra += `\n[discord verify] exit=${get.code}\n${get.output || "(no output)"}`;
        }
      }

      // Slack
      if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
        if (!supports("slack")) {
          extra += "\n[slack] skipped (not supported)\n";
        } else {
          const cfgObj: Record<string, any> = { enabled: true };
          if (payload.slackBotToken?.trim()) cfgObj.botToken = payload.slackBotToken.trim();
          if (payload.slackAppToken?.trim()) cfgObj.appToken = payload.slackAppToken.trim();
          const set = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "channels.slack", JSON.stringify(cfgObj)]));
          const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.slack"]));
          extra += `\n[slack config] exit=${set.code}\n${set.output || "(no output)"}`;
          extra += `\n[slack verify] exit=${get.code}\n${get.output || "(no output)"}`;
        }
      }

      await restartGateway();
      const fix = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
      extra += `\n[doctor --fix] exit=${fix.code}\n${fix.output || "(no output)"}`;
      await restartGateway();
    }

    return json({ ok, output: `${prefix}${onboard.output}${extra}` }, ok ? 200 : 500);
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return json({ ok: false, output: `Internal error: ${String(err)}` }, 500);
  }
}

async function handleSetupDebug(): Promise<Response> {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
  const tg = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));
  const dc = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));

  return json({
    wrapper: {
      bun: Bun.version,
      port: PORT,
      publicPortEnv: process.env.PORT || null,
      stateDir: STATE_DIR, workspaceDir: WORKSPACE_DIR,
      configured: isConfigured(), configPathResolved: configPath(),
      configPathCandidates: resolveConfigCandidates(),
      internalGatewayHost: INTERNAL_GATEWAY_HOST, internalGatewayPort: INTERNAL_GATEWAY_PORT,
      gatewayTarget: GATEWAY_TARGET, gatewayRunning: Boolean(gatewayProc),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(path.join(STATE_DIR, "gateway.token")),
      lastGatewayError, lastGatewayExit, lastDoctorAt, lastDoctorOutput,
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY, node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
      channels: {
        telegram: {
          exit: tg.code,
          configuredEnabled: /"enabled"\s*:\s*true/.test(tg.output) || /enabled\s*[:=]\s*true/.test(tg.output),
          botTokenPresent: /(\d{5,}:[A-Za-z0-9_-]{10,})/.test(tg.output),
          output: redactSecrets(tg.output),
        },
        discord: {
          exit: dc.code,
          configuredEnabled: /"enabled"\s*:\s*true/.test(dc.output) || /enabled\s*[:=]\s*true/.test(dc.output),
          tokenPresent: /"token"\s*:\s*"?\S+"?/.test(dc.output) || /token\s*[:=]\s*\S+/.test(dc.output),
          output: redactSecrets(dc.output),
        },
      },
    },
  });
}

async function handleConsoleRun(req: Request): Promise<Response> {
  const payload = (await req.json()) as { cmd?: string; arg?: string };
  const cmd = String(payload.cmd || "").trim();
  const arg = String(payload.arg || "").trim();

  if (!ALLOWED_CONSOLE_COMMANDS.has(cmd)) {
    return json({ ok: false, error: "Command not allowed" }, 400);
  }

  try {
    if (cmd === "gateway.restart") {
      await restartGateway();
      return json({ ok: true, output: "Gateway restarted (wrapper-managed).\n" });
    }
    if (cmd === "gateway.stop") {
      if (gatewayProc) { try { gatewayProc.kill(); } catch { /* ignore */ } await sleep(750); gatewayProc = null; }
      return json({ ok: true, output: "Gateway stopped (wrapper-managed).\n" });
    }
    if (cmd === "gateway.start") {
      const r = await ensureGatewayRunning();
      return json({ ok: Boolean(r.ok), output: r.ok ? "Gateway started.\n" : `Gateway not started: ${r.reason}\n` });
    }

    const cmdMap: Record<string, () => Promise<RunCmdResult>> = {
      "openclaw.version": () => runCmd(OPENCLAW_NODE, clawArgs(["--version"])),
      "openclaw.status": () => runCmd(OPENCLAW_NODE, clawArgs(["status"])),
      "openclaw.health": () => runCmd(OPENCLAW_NODE, clawArgs(["health"])),
      "openclaw.doctor": () => runCmd(OPENCLAW_NODE, clawArgs(["doctor"])),
      "openclaw.logs.tail": () => {
        const lines = Math.max(50, Math.min(1000, parseInt(arg || "200", 10) || 200));
        return runCmd(OPENCLAW_NODE, clawArgs(["logs", "--tail", String(lines)]));
      },
      "openclaw.config.get": () => {
        if (!arg) throw new Error("Missing config path");
        return runCmd(OPENCLAW_NODE, clawArgs(["config", "get", arg]));
      },
      "openclaw.devices.list": () => runCmd(OPENCLAW_NODE, clawArgs(["devices", "list"])),
      "openclaw.devices.approve": () => {
        if (!arg || !/^[A-Za-z0-9_-]+$/.test(arg)) throw new Error("Invalid device request ID");
        return runCmd(OPENCLAW_NODE, clawArgs(["devices", "approve", arg]));
      },
      "openclaw.plugins.list": () => runCmd(OPENCLAW_NODE, clawArgs(["plugins", "list"])),
      "openclaw.plugins.enable": () => {
        if (!arg || !/^[A-Za-z0-9_-]+$/.test(arg)) throw new Error("Invalid plugin name");
        return runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", arg]));
      },
    };

    const handler = cmdMap[cmd];
    if (!handler) return json({ ok: false, error: "Unhandled command" }, 400);

    const r = await handler();
    return json({ ok: r.code === 0, output: redactSecrets(r.output) }, r.code === 0 ? 200 : 500);
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
}

function handleConfigGet(): Response {
  try {
    const p = configPath();
    const exists = fs.existsSync(p);
    const content = exists ? fs.readFileSync(p, "utf8") : "";
    return json({ ok: true, path: p, exists, content });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
}

async function handleConfigSave(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { content?: string };
    const content = String(body.content || "");
    if (content.length > 500_000) return json({ ok: false, error: "Config too large" }, 413);

    fs.mkdirSync(STATE_DIR, { recursive: true });
    const p = configPath();
    if (fs.existsSync(p)) {
      const backupPath = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(p, backupPath);
    }
    fs.writeFileSync(p, content, { encoding: "utf8", mode: 0o600 });
    if (isConfigured()) await restartGateway();
    return json({ ok: true, path: p });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
}

async function handlePairingApprove(req: Request): Promise<Response> {
  const { channel, code } = (await req.json()) as { channel?: string; code?: string };
  if (!channel || !code) return json({ ok: false, error: "Missing channel or code" }, 400);
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", String(channel), String(code)]));
  return json({ ok: r.code === 0, output: r.output }, r.code === 0 ? 200 : 500);
}

async function handleDevicesPending(): Promise<Response> {
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "list"]));
  const output = redactSecrets(r.output);
  const requestIds = extractDeviceRequestIds(output);
  return json({ ok: r.code === 0, requestIds, output }, r.code === 0 ? 200 : 500);
}

async function handleDevicesApprove(req: Request): Promise<Response> {
  const { requestId } = (await req.json()) as { requestId?: string };
  const id = String(requestId || "").trim();
  if (!id) return json({ ok: false, error: "Missing device request ID" }, 400);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return json({ ok: false, error: "Invalid device request ID" }, 400);
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "approve", id]));
  return json({ ok: r.code === 0, output: redactSecrets(r.output) }, r.code === 0 ? 200 : 500);
}

async function handleReset(): Promise<Response> {
  try {
    if (gatewayProc) { try { gatewayProc.kill(); } catch { /* ignore */ } await sleep(750); gatewayProc = null; }
    const candidates = resolveConfigCandidates();
    for (const p of candidates) { try { fs.rmSync(p, { force: true }); } catch { /* ignore */ } }
    return text("OK - stopped gateway and deleted config file(s). You can rerun setup now.");
  } catch (err) {
    return text(String(err), 500);
  }
}

async function handleExport(): Promise<Response> {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);
  const dataRoot = "/data";
  const underData = (p: string) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  const stream = await tarCreate(cwd, paths);

  return new Response(stream, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
    },
  });
}

async function handleImport(req: Request): Promise<Response> {
  try {
    const dataRoot = "/data";
    if (!isUnderDir(STATE_DIR, dataRoot) || !isUnderDir(WORKSPACE_DIR, dataRoot)) {
      return text("Import is only supported when OPENCLAW_STATE_DIR and OPENCLAW_WORKSPACE_DIR are under /data.\n", 400);
    }

    if (gatewayProc) { try { gatewayProc.kill(); } catch { /* ignore */ } await sleep(750); gatewayProc = null; }

    const buf = Buffer.from(await req.arrayBuffer());
    if (!buf.length) return text("Empty body\n", 400);

    const tmpPath = path.join(os.tmpdir(), `openclaw-import-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmpPath, buf);

    await tarExtract(dataRoot, tmpPath);
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }

    if (isConfigured()) await restartGateway();
    return text("OK - imported backup into /data and restarted gateway.\n");
  } catch (err) {
    console.error("[import]", err);
    return text(String(err), 500);
  }
}

// ---------------------------------------------------------------------------
// HTTP proxy to gateway
// ---------------------------------------------------------------------------
async function proxyToGateway(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const targetUrl = `${GATEWAY_TARGET}${url.pathname}${url.search}`;

  const headers = new Headers(req.headers);
  if (!headers.get("authorization") && OPENCLAW_GATEWAY_TOKEN) {
    headers.set("authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
  }
  // Remove host header to avoid confusing the upstream
  headers.delete("host");

  try {
    const resp = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.body,
      // @ts-ignore - Bun supports duplex
      duplex: "half",
    });

    // Clone response headers
    const respHeaders = new Headers(resp.headers);

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
    });
  } catch (err) {
    console.error("[proxy]", err);
    return text("Gateway unavailable\n", 502);
  }
}

// ---------------------------------------------------------------------------
// WebSocket proxy
// ---------------------------------------------------------------------------
interface WSData {
  targetUrl: string;
  upstream: WebSocket | null;
  buffered: (string | Buffer)[];
}

// ---------------------------------------------------------------------------
// Bun.serve
// ---------------------------------------------------------------------------
const server = Bun.serve<WSData>({
  port: PORT,
  hostname: "0.0.0.0",

  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (!isConfigured()) {
        return new Response("Not configured", { status: 503 });
      }
      try {
        await ensureGatewayRunning();
      } catch {
        return new Response("Gateway not ready", { status: 503 });
      }

      const wsTarget = `ws://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}${url.pathname}${url.search}`;

      const success = server.upgrade(req, {
        data: {
          targetUrl: wsTarget,
          upstream: null,
          buffered: [],
        } satisfies WSData,
      });

      if (success) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    return handleRequest(req);
  },

  websocket: {
    open(ws) {
      const data = ws.data as WSData;
      let targetUrl = data.targetUrl;

      // Inject auth token via query param for WS (headers not supported in WS constructor)
      const u = new URL(targetUrl);
      if (OPENCLAW_GATEWAY_TOKEN) {
        u.searchParams.set("token", OPENCLAW_GATEWAY_TOKEN);
      }
      targetUrl = u.toString();

      const upstream = new WebSocket(targetUrl);

      upstream.onopen = () => {
        // Flush buffered messages
        for (const msg of data.buffered) {
          upstream.send(msg as any);
        }
        data.buffered = [];
      };

      upstream.onmessage = (event) => {
        try {
          ws.send(event.data as any);
        } catch { /* client gone */ }
      };

      upstream.onclose = () => {
        try { ws.close(); } catch { /* ignore */ }
      };

      upstream.onerror = () => {
        try { ws.close(); } catch { /* ignore */ }
      };

      data.upstream = upstream;
    },

    message(ws, message) {
      const data = ws.data as WSData;
      if (data.upstream && data.upstream.readyState === WebSocket.OPEN) {
        data.upstream.send(message);
      } else {
        data.buffered.push(message as any);
      }
    },

    close(ws) {
      const data = ws.data as WSData;
      if (data.upstream) {
        try { data.upstream.close(); } catch { /* ignore */ }
      }
    },
  },
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
console.log(`[wrapper] listening on :${PORT}`);
console.log(`[wrapper] state dir: ${STATE_DIR}`);
console.log(`[wrapper] workspace dir: ${WORKSPACE_DIR}`);

try { fs.mkdirSync(path.join(STATE_DIR, "credentials"), { recursive: true }); } catch { /* ignore */ }
try { fs.chmodSync(STATE_DIR, 0o700); } catch { /* ignore */ }

console.log(`[wrapper] gateway token: ${OPENCLAW_GATEWAY_TOKEN ? "(set)" : "(missing)"}`);
console.log(`[wrapper] gateway target: ${GATEWAY_TARGET}`);
if (!SETUP_PASSWORD) console.warn("[wrapper] WARNING: SETUP_PASSWORD is not set; /setup will error.");

const ghWebhookEnabled = !!(GITHUB_APP_ID && GITHUB_INSTALLATION_ID && GITHUB_APP_PEM_PATH);
console.log(`[wrapper] github webhook proxy: ${ghWebhookEnabled ? "enabled" : "disabled"} (POST /github/webhook)`);

// Bootstrap script
const bootstrapPath = path.join(WORKSPACE_DIR, "bootstrap.sh");
if (fs.existsSync(bootstrapPath)) {
  console.log(`[wrapper] running bootstrap: ${bootstrapPath}`);
  try {
    await runCmd("bash", [bootstrapPath], {
      env: { OPENCLAW_STATE_DIR: STATE_DIR, OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR },
      timeoutMs: 10 * 60 * 1000,
    });
    console.log("[wrapper] bootstrap complete");
  } catch (err) {
    console.warn(`[wrapper] bootstrap failed (continuing): ${String(err)}`);
  }
}

// Auto-start gateway
if (isConfigured()) {
  console.log("[wrapper] config detected; starting gateway...");
  try {
    await ensureGatewayRunning();
    console.log("[wrapper] gateway ready");
  } catch (err) {
    console.error(`[wrapper] gateway failed to start at boot: ${String(err)}`);
  }
}

// Graceful shutdown
process.on("SIGTERM", () => {
  try { if (gatewayProc) gatewayProc.kill(); } catch { /* ignore */ }
  try { server.stop(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 5_000).unref?.();
});
