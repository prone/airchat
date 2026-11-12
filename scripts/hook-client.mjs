// Shared by the AirChat hooks (check-work, wake-wait, wake-inject): reading
// ~/.airchat, deriving this session's agent name, and calling /api/v2 with the
// agent's derived key. Plain Node, no dependencies, because hooks run from a
// bare checkout on every prompt.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import crypto from 'crypto';
import { hookAgentName } from './check-work-plan.mjs';

export const airchatDir = join(homedir(), '.airchat');
export const cacheDir = join(airchatDir, 'cache');

/** Parse ~/.airchat/config (KEY=value lines). Null when it cannot be read. */
export function readConfig() {
  const config = {};
  try {
    for (const line of readFileSync(join(airchatDir, 'config'), 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      config[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch { return null; }
  return config;
}

// ── Reading a response ──────────────────────────────────────────────────────

/** The most a hook reads from one answer. A page of work is a few kilobytes. */
export const MAX_HOOK_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_HOOK_ERROR_BYTES = 16 * 1024;

/**
 * Read a response body, stopping at `maxBytes`.
 *
 * `res.json()` and `res.text()` hold the whole body in memory before they
 * return, however large it is, and a hook runs on every prompt of every
 * session. A server that answers with an endless body would otherwise fill
 * the machine's memory from a hook nobody is watching. Here the read stops
 * and the connection is dropped as soon as the limit is passed.
 *
 * Returns the text, or null when the body was larger than the limit.
 */
export async function readCapped(res, maxBytes = MAX_HOOK_RESPONSE_BYTES) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/** The body as JSON. Throws when it is too large or is not JSON. */
export async function readJsonBody(res, maxBytes = MAX_HOOK_RESPONSE_BYTES) {
  const text = await readCapped(res, maxBytes);
  if (text === null) throw new Error(`Response larger than ${maxBytes} bytes`);
  return JSON.parse(text);
}

// ── Crypto helpers (mirror packages/shared/src/crypto.ts) ───────────────────

function signRegistration(privKeyHex, payload) {
  // Reconstruct Ed25519 private key from 32-byte hex seed
  const seed = Buffer.from(privKeyHex, 'hex');
  const pkcs8Header = Buffer.from('302e020100300506032b657004220420', 'hex');
  const key = crypto.createPrivateKey({ key: Buffer.concat([pkcs8Header, seed]), format: 'der', type: 'pkcs8' });

  // Canonical JSON array format — must match all SDKs exactly
  const message = Buffer.from(JSON.stringify([
    payload.machine_name,
    payload.agent_name,
    payload.derived_key_hash,
    payload.timestamp,
    payload.nonce,
  ]), 'utf-8');

  return crypto.sign(null, message, key).toString('base64');
}

/**
 * Everything a hook needs to talk to the server as this session's agent, or
 * null when AirChat is not set up on this machine (a hook then does nothing).
 */
export function openClient() {
  const config = readConfig();
  if (!config) return null;
  const { MACHINE_NAME, AIRCHAT_WEB_URL } = config;
  if (!MACHINE_NAME || !AIRCHAT_WEB_URL) return null;

  let privateKeyHex;
  try {
    privateKeyHex = readFileSync(join(airchatDir, 'machine.key'), 'utf-8').trim();
  } catch { return null; }

  const webUrl = AIRCHAT_WEB_URL.replace(/\/+$/, '');
  const agentName = hookAgentName(MACHINE_NAME, process.cwd(), process.env.AIRCHAT_PROJECT);
  const agentsDir = join(airchatDir, 'agents');
  const keyFilePath = join(agentsDir, `${agentName}.key`);

  function loadCachedKey() {
    try {
      // Single read, no exists-then-read race — ENOENT lands in the catch.
      const key = readFileSync(keyFilePath, 'utf-8').trim();
      return /^[0-9a-f]{64}$/.test(key) ? key : null;
    } catch {
      return null;
    }
  }

  async function ensureDerivedKey() {
    const cached = loadCachedKey();
    if (cached) return cached;

    // Generate a new derived key and register it, signed by the machine key.
    const derivedKey = crypto.randomBytes(32).toString('hex');
    const payload = {
      machine_name: MACHINE_NAME,
      agent_name: agentName,
      derived_key_hash: crypto.createHash('sha256').update(derivedKey).digest('hex'),
      timestamp: new Date().toISOString(),
      nonce: crypto.randomBytes(16).toString('hex'),
    };
    const res = await fetch(`${webUrl}/api/v2/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, signature: signRegistration(privateKeyHex, payload) }),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const body = (await readCapped(res, MAX_HOOK_ERROR_BYTES).catch(() => '')) ?? '(body too large to show)';
      throw new Error(`Registration failed: HTTP ${res.status} — ${body}`);
    }
    try {
      mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
      writeFileSync(keyFilePath, derivedKey, { mode: 0o600 });
    } catch {}
    return derivedKey;
  }

  /**
   * GET a /api/v2 path as this agent. On 401 the derived key is registered
   * again and the request retried once (the key may have been invalidated).
   * Returns the fetch Response.
   */
  async function get(pathAndQuery, timeoutMs = 5000) {
    const send = (key) => fetch(`${webUrl}${pathAndQuery}`, {
      headers: { 'x-agent-api-key': key },
      // The key goes to the configured server and nowhere else: fetch would
      // carry this header along to wherever a redirect pointed.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const used = await ensureDerivedKey();
    let res = await send(used);
    if (res.status === 401) {
      // Another hook process may have registered a new key meanwhile; try
      // that one before registering yet another and invalidating theirs.
      const current = loadCachedKey();
      if (current && current !== used) res = await send(current);
    }
    if (res.status === 401) {
      try { writeFileSync(keyFilePath, ''); } catch {}
      res = await send(await ensureDerivedKey());
    }
    return res;
  }

  return { config, agentName, webUrl, get };
}

/**
 * /api/v2 wraps every success in a prompt-injection boundary:
 *   { _airchat: 'response', _notice: '...', data: {...} }
 *
 * The predecessor of check-work.mjs read `body.mentions` after the envelope
 * was introduced, so it took the "nothing to say" branch and exited silently
 * on every run for months. Accept both shapes so that cannot happen again.
 */
export function unwrap(body) {
  return body && typeof body === 'object' && '_airchat' in body && 'data' in body ? body.data : body;
}

/** Read and parse a JSON file; `fallback` when missing or unreadable. */
export function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf-8')); } catch { return fallback; }
}

/** Write a JSON file under ~/.airchat/cache. Failures are ignored. */
export function writeJson(file, value) {
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  } catch {}
}
