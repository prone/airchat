import { plan, shouldRequest, normalizeState } from './check-work-plan.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import crypto from 'crypto';

// check-work.mjs — the "anything for me?" hook.
//
// Successor to check-mentions.mjs: one call to /api/v2/work returns unread
// mentions PLUS open tasks matching this agent's capability card, its own
// claimed tasks, and completions of tasks it posted. The installer wires it
// to three Claude Code events — UserPromptSubmit, SessionStart and Stop — and
// check-work-plan.mjs decides what each one says. Other harnesses run it from
// their own hook mechanisms or at session start.

// ── Which event fired ───────────────────────────────────────────────────────
// Claude Code passes a JSON description of the event on stdin. Run by hand
// (a terminal on stdin) or by another harness, it behaves as a prompt hook.
let hookInput = {};
if (!process.stdin.isTTY) {
  try { hookInput = JSON.parse(readFileSync(0, 'utf-8')) ?? {}; } catch {}
}
const event = ['Stop', 'SessionStart'].includes(hookInput.hook_event_name)
  ? hookInput.hook_event_name
  : 'UserPromptSubmit';
const stopHookActive = hookInput.stop_hook_active === true;
const airchatDir = join(homedir(), '.airchat');

const cacheDir = join(airchatDir, 'cache');

// ── Read config ─────────────────────────────────────────────────────────────
let config = {};
try {
  const lines = readFileSync(join(airchatDir, 'config'), 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    config[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
} catch { process.exit(0); }

const { MACHINE_NAME, AIRCHAT_WEB_URL } = config;
if (!MACHINE_NAME || !AIRCHAT_WEB_URL) process.exit(0);

const webUrl = AIRCHAT_WEB_URL.replace(/\/+$/, '');

// ── Read private key ────────────────────────────────────────────────────────
let privateKeyHex;
try {
  privateKeyHex = readFileSync(join(airchatDir, 'machine.key'), 'utf-8').trim();
} catch { process.exit(0); }

// ── Derive agent name ───────────────────────────────────────────────────────
const cwd = process.cwd();
const dirName = basename(cwd);
const agentName = `${MACHINE_NAME}-${dirName}`;

// ── State — PER AGENT ───────────────────────────────────────────────────────
//
// What this agent has already been shown, and when. It is per agent on
// purpose: an earlier version kept one timer for the whole machine, so the
// first agent to check silenced every other agent for five minutes — a session
// in another project produced nothing at all until the file was deleted by
// hand.
const stateFile = join(cacheDir, `work-state-${agentName}.json`);
let state;
try { state = normalizeState(JSON.parse(readFileSync(stateFile, 'utf-8'))); } catch { state = normalizeState(null); }

function saveState(next) {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(stateFile, JSON.stringify(next));
  } catch {}
}

const now = Date.now();
if (!shouldRequest({ event, stopHookActive, state, now })) process.exit(0);

// The hook now asks the server on every prompt, so an unreachable server must
// not cost every prompt a timeout: one failure pauses the hook for a while.
function noteFailure() {
  saveState({ ...state, lastFailure: now });
}

// ── Crypto helpers (inline, mirrors packages/shared/src/crypto.ts) ──────────

function generateDerivedKey() {
  return crypto.randomBytes(32).toString('hex');
}

function generateNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function signRegistration(privKeyHex, payload) {
  // Reconstruct Ed25519 private key from 32-byte hex seed
  const seed = Buffer.from(privKeyHex, 'hex');
  const pkcs8Header = Buffer.from('302e020100300506032b657004220420', 'hex');
  const pkcs8Der = Buffer.concat([pkcs8Header, seed]);
  const key = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });

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

// ── Derived key cache ───────────────────────────────────────────────────────

const agentsDir = join(airchatDir, 'agents');
const keyFilePath = join(agentsDir, `${agentName}.key`);

function loadCachedKey() {
  try {
    // Single read, no exists-then-read race — ENOENT lands in the catch.
    const key = readFileSync(keyFilePath, 'utf-8').trim();
    if (!key) return null;
    if (!key.match(/^[0-9a-f]{64}$/)) return null;
    return key;
  } catch {
    return null;
  }
}

function saveCachedKey(key) {
  try {
    mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
    writeFileSync(keyFilePath, key, { mode: 0o600 });
  } catch {}
}

// ── Registration flow ───────────────────────────────────────────────────────

async function ensureDerivedKey() {
  // Try cached key first
  const cached = loadCachedKey();
  if (cached) return cached;

  // Generate new derived key and register
  const derivedKey = generateDerivedKey();
  const derivedKeyHash = hashKey(derivedKey);
  const timestamp = new Date().toISOString();
  const nonce = generateNonce();

  const payload = {
    machine_name: MACHINE_NAME,
    agent_name: agentName,
    derived_key_hash: derivedKeyHash,
    timestamp,
    nonce,
  };

  const signature = signRegistration(privateKeyHex, payload);

  const res = await fetch(`${webUrl}/api/v2/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, signature }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Registration failed: HTTP ${res.status} — ${body}`);
  }

  saveCachedKey(derivedKey);
  return derivedKey;
}

// ── Main ────────────────────────────────────────────────────────────────────

try {
  let derivedKey = await ensureDerivedKey();

  let res = await fetch(`${webUrl}/api/v2/work`, {
    headers: { 'x-agent-api-key': derivedKey },
    signal: AbortSignal.timeout(5000),
  });

  // On 401, re-register and retry once (derived key may have been invalidated)
  if (res.status === 401) {
    // Delete cached key and re-register
    try { writeFileSync(keyFilePath, ''); } catch {}
    derivedKey = await ensureDerivedKey();
    res = await fetch(`${webUrl}/api/v2/work`, {
      headers: { 'x-agent-api-key': derivedKey },
      signal: AbortSignal.timeout(5000),
    });
  }

  if (!res.ok) {
    if (res.status >= 500 || res.status === 429) noteFailure();
    process.exit(0);
  }

  const body = await res.json();

  // /api/v2 wraps every success in a prompt-injection boundary:
  //   { _airchat: 'response', _notice: '...', data: {...} }
  //
  // The predecessor of this script (check-mentions.mjs) read `body.mentions`
  // after the envelope was introduced, so it took the "nothing to say" branch
  // and exited silently on every run for months — a hook that prints nothing
  // looks exactly like a hook with nothing to say. Accept both shapes so it
  // cannot break that way again.
  const payload = body && typeof body === 'object' && '_airchat' in body && 'data' in body
    ? body.data
    : body;

  const result = plan({ event, payload, state, now, stopHookActive });
  saveState(result.state);
  if (result.mode === 'block') {
    // Stop hook protocol: this keeps the agent going, with `reason` as what it
    // is told. Plain text on stdout would be ignored for this event.
    console.log(JSON.stringify({ decision: 'block', reason: result.text }));
  } else if (result.mode === 'context') {
    console.log(result.text);
  }
} catch (err) {
  noteFailure();
  console.error('[check-work]', err?.message ?? err);
  process.exit(0);
}
