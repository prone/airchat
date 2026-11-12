// Per-session marker files for the wake hooks, under ~/.airchat/cache.
//
// Four hooks in the same session have to agree on a little state, and they
// run as separate short-lived processes. One small file per fact (instead of
// one shared JSON file) means no hook ever rewrites another's fact.
//
//   sess-<id>.busy     a turn is running (set on a prompt, cleared at Stop)
//   sess-<id>.woken    this turn was started by a message; holds the tier and
//                      the senders. Present = the tool gate is on.
//   sess-<id>.pending  a message arrived mid-turn; show it after the next tool
//   sess-<id>.waiter   pid of the process waiting for messages

import { readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, statSync, appendFileSync } from 'fs';
import { join } from 'path';
import { cacheDir } from './hook-client.mjs';

const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const AUDIT_MAX_BYTES = 1024 * 1024;

const fileOf = (sessionId, kind) => join(cacheDir, `sess-${sessionId}.${kind}`);

export function setMarker(sessionId, kind, value = '') {
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    writeFileSync(fileOf(sessionId, kind), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  } catch {}
}

export function clearMarker(sessionId, kind) {
  try { rmSync(fileOf(sessionId, kind), { force: true }); } catch {}
}

/** The marker's text, or null when it is not set. */
export function readMarker(sessionId, kind) {
  try { return readFileSync(fileOf(sessionId, kind), 'utf-8'); } catch { return null; }
}

export function hasMarker(sessionId, kind) {
  return readMarker(sessionId, kind) !== null;
}

/**
 * The woken marker as an object, or null when the session is not in a woken
 * turn. A marker that exists but cannot be parsed still counts as woken, at
 * the strictest tier: a damaged file must not switch the gate off.
 */
export function readWoken(sessionId) {
  const raw = readMarker(sessionId, 'woken');
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return { tier: 'reply', senders: [] };
}

/**
 * Become this session's waiter unless one is already running. Returns false
 * when another live process holds the role.
 */
export function claimWaiter(sessionId) {
  const held = Number(readMarker(sessionId, 'waiter'));
  if (Number.isInteger(held) && held > 0 && held !== process.pid) {
    try { process.kill(held, 0); return false; } catch { /* gone: take over */ }
  }
  setMarker(sessionId, 'waiter', String(process.pid));
  return Number(readMarker(sessionId, 'waiter')) === process.pid;
}

/**
 * Claim one mention for this session, so two sessions of the same agent are
 * not both woken by the same message. First writer wins.
 */
export function claimMention(mentionId) {
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(cacheDir, `woke-${String(mentionId).replace(/[^A-Za-z0-9-]/g, '')}`), String(process.pid), { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** One line per wake and per tool decision in a woken turn. Never content. */
export function audit(entry) {
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const file = join(cacheDir, 'wake-audit.log');
    try { if (statSync(file).size > AUDIT_MAX_BYTES) rmSync(file, { force: true }); } catch {}
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  } catch {}
}

/** Remove marker and claim files nobody has touched for a week. */
export function pruneStale(now = Date.now()) {
  try {
    for (const name of readdirSync(cacheDir)) {
      if (!name.startsWith('sess-') && !name.startsWith('woke-')) continue;
      const file = join(cacheDir, name);
      try { if (now - statSync(file).mtimeMs > STALE_MS) rmSync(file, { force: true }); } catch {}
    }
  } catch {}
}

/**
 * What to tell the user's next turn about the time this session spent woken:
 * who woke it and which tools were refused. Built from the audit log, so it
 * holds no message text.
 */
export function wokenSummary(sessionId, woken) {
  const since = Number.isFinite(woken?.at) ? woken.at : 0;
  const senders = new Set(Array.isArray(woken?.senders) ? woken.senders.map(String) : []);
  const refused = new Set();
  let wakes = 0;
  try {
    for (const line of readFileSync(join(cacheDir, 'wake-audit.log'), 'utf-8').split('\n')) {
      if (!line.includes(sessionId)) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.session !== sessionId) continue;
      if (entry.event === 'wake') {
        wakes += 1;
        for (const s of Array.isArray(entry.senders) ? entry.senders : []) senders.add(String(s));
      } else if (entry.event === 'tool-refused' && Date.parse(entry.at) >= since) {
        refused.add(String(entry.tool).replace(/[^A-Za-z0-9_-]/g, ''));
      }
    }
  } catch {}
  const who = [...senders].map((s) => s.replace(/[^a-z0-9-]/g, '')).filter(Boolean).join(', ') || 'another agent';
  return 'AirChat: while the user was away, a direct message from ' + who + ' started a turn in this session'
    + (wakes > 1 ? ` (${wakes} times in all)` : '')
    + (refused.size ? `. Tools it asked for and was refused: ${[...refused].join(', ')}` : '')
    + '. The restriction on tools has ended now that the user is back. Mention this to the user in one line.';
}
