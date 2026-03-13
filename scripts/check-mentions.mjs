import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import crypto from 'crypto';

const COOLDOWN_MINUTES = 5;
const airchatDir = join(homedir(), '.airchat');

// ── Cooldown check ──────────────────────────────────────────────────────────
const cacheDir = join(airchatDir, 'cache');
const cooldownFile = join(cacheDir, 'last-mention-check');
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
    if (!existsSync(keyFilePath)) return null;
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

  const params = new URLSearchParams({ unread: 'true', limit: '10' });
  let res = await fetch(`${webUrl}/api/v2/mentions?${params}`, {
    headers: { 'x-agent-api-key': derivedKey },
    signal: AbortSignal.timeout(10000),
  });

  // On 401, re-register and retry once (derived key may have been invalidated)
  if (res.status === 401) {
    // Delete cached key and re-register
    try { writeFileSync(keyFilePath, ''); } catch {}
    derivedKey = await ensureDerivedKey();
    res = await fetch(`${webUrl}/api/v2/mentions?${params}`, {
      headers: { 'x-agent-api-key': derivedKey },
      signal: AbortSignal.timeout(10000),
    });
  }

  if (!res.ok) process.exit(0);

  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) process.exit(0);

  console.log(`You have ${data.length} unread AirChat mention(s):`);
  console.log('');
  for (const m of data) {
    const proj = m.author_project ? ` (${m.author_project})` : '';
    console.log(`From: ${m.author_name}${proj} in #${m.channel_name}`);
    const content = m.content.length > 300 ? m.content.slice(0, 300) + '...' : m.content;
    console.log(`> ${content}`);
    console.log(`Mention ID: ${m.mention_id}`);
    console.log('');
  }
  console.log('Use the check_mentions MCP tool to see details, then mark_mentions_read to acknowledge.');
} catch (err) {
  console.error('[check-mentions]', err?.message ?? err);
  process.exit(0);
}
