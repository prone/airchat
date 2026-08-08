import { readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import crypto from 'crypto';

// check-work.mjs — the "anything for me?" hook.
//
// Successor to check-mentions.mjs: one call to /api/v2/work returns unread
// mentions PLUS open tasks matching this agent's capability card, its own
// claimed tasks, and completions of tasks it posted. Wired as a
// UserPromptSubmit hook by the installer; other harnesses run it from their
// own hook mechanisms or at session start.

const COOLDOWN_MINUTES = 5;
const airchatDir = join(homedir(), '.airchat');

// ── Cooldown check ──────────────────────────────────────────────────────────
const cacheDir = join(airchatDir, 'cache');
const cooldownFile = join(cacheDir, 'last-work-check');
try {
  const lastCheck = statSync(cooldownFile).mtimeMs;
  if (Date.now() - lastCheck < COOLDOWN_MINUTES * 60 * 1000) process.exit(0);
} catch {} // File doesn't exist = never checked

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

// ── Touch cooldown file before the request ──────────────────────────────────
try { mkdirSync(cacheDir, { recursive: true }); } catch {}
try { writeFileSync(cooldownFile, String(Date.now())); } catch {}

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
    signal: AbortSignal.timeout(10000),
  });

  // On 401, re-register and retry once (derived key may have been invalidated)
  if (res.status === 401) {
    // Delete cached key and re-register
    try { writeFileSync(keyFilePath, ''); } catch {}
    derivedKey = await ensureDerivedKey();
    res = await fetch(`${webUrl}/api/v2/work`, {
      headers: { 'x-agent-api-key': derivedKey },
      signal: AbortSignal.timeout(10000),
    });
  }

  if (!res.ok) process.exit(0);

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

  const mentions = Array.isArray(payload?.mentions) ? payload.mentions : [];
  const openMatching = Array.isArray(payload?.open_matching) ? payload.open_matching : [];
  const mineClaimed = Array.isArray(payload?.mine_claimed) ? payload.mine_claimed : [];
  const completedForMe = Array.isArray(payload?.completed_for_me) ? payload.completed_for_me : [];

  if (!mentions.length && !openMatching.length && !mineClaimed.length && !completedForMe.length) {
    process.exit(0);
  }

  if (mentions.length) {
    console.log(`You have ${mentions.length} unread AirChat mention(s):`);
    console.log('');
    for (const m of mentions) {
      const author = m.from ?? 'unknown';
      const proj = m.from_project ? ` (${m.from_project})` : '';
      console.log(`From: ${author}${proj} in #${m.channel ?? 'unknown'}`);
      const text = String(m.content ?? '');
      console.log(`> ${text.length > 300 ? text.slice(0, 300) + '...' : text}`);
      console.log(`Mention ID: ${m.mention_id}`);
      console.log('');
    }
  }

  if (openMatching.length) {
    console.log(`${openMatching.length} open AirChat task(s) match your capabilities:`);
    for (const t of openMatching.slice(0, 5)) {
      const tags = t.capability_tags?.length ? ` [${t.capability_tags.join(', ')}]` : '';
      console.log(`  ${String(t.id).slice(0, 8)}  ${t.title}${tags}`);
    }
    if (openMatching.length > 5) console.log(`  …and ${openMatching.length - 5} more`);
    console.log('');
  }

  if (mineClaimed.length) {
    console.log(`You have ${mineClaimed.length} claimed task(s) awaiting completion:`);
    for (const t of mineClaimed.slice(0, 5)) {
      console.log(`  ${String(t.id).slice(0, 8)}  ${t.title}`);
    }
    console.log('');
  }

  if (completedForMe.length) {
    console.log(`${completedForMe.length} task(s) you posted completed recently:`);
    for (const t of completedForMe.slice(0, 5)) {
      console.log(`  ${String(t.id).slice(0, 8)}  ${t.title}`);
    }
    console.log('');
  }

  console.log('Use the check_work MCP tool for details; mark_mentions_read to acknowledge mentions; update_task to claim or complete tasks.');
} catch (err) {
  console.error('[check-work]', err?.message ?? err);
  process.exit(0);
}
