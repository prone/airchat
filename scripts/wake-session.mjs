// Per-session marker files for the wake hooks, under ~/.airchat/cache.
//
// Four hooks in the same session have to agree on a little state, and they
// run as separate short-lived processes. One small file per fact (instead of
// one shared JSON file) means no hook ever rewrites another's fact.
//
//   sess-<id>.busy     a turn is running (set on a prompt, cleared at Stop)
//   sess-<id>.woken    this turn was started by a message; holds the tier and
//                      the senders. Present = the tool gate is on.
//   sess-<id>.calls    tool calls allowed so far in this woken turn
//   sess-<id>.pending  a message arrived mid-turn; show it after the next tool
//   sess-<id>.waiter   pid of the process waiting for messages
//
// Two more kinds of file are not per session:
//
//   wake-ticket-<hex>          what one wake stands for (tier, senders), until
//                              the turn it started picks it up
//   sess-claude-<pid>.current  the session id a Claude Code process is on now

import {
  readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, statSync, appendFileSync, renameSync, openSync, fstatSync, closeSync,
} from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { homedir } from 'os';
import { cacheDir } from './hook-client.mjs';
import { hasGateHook } from './wake-lib.mjs';

const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const AUDIT_MAX_BYTES = 1024 * 1024;

const fileOf = (sessionId, kind) => join(cacheDir, `sess-${sessionId}.${kind}`);

/** Write a marker. Returns false when it could not be written. */
export function setMarker(sessionId, kind, value = '') {
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    writeFileSync(fileOf(sessionId, kind), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
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
  let raw;
  try {
    raw = readFileSync(fileOf(sessionId, 'woken'), 'utf-8');
  } catch (err) {
    // Only "no such file" means not woken. A marker that is there but cannot
    // be read (permissions, a full or failing disk) keeps the gate on.
    return err?.code === 'ENOENT' ? null : { tier: 'reply', senders: [] };
  }
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
 * not both woken by the same message. The first session to ask wins, and
 * keeps the claim if it asks again (it may have had to put the wake off).
 */
export function claimMention(mentionId, sessionId) {
  const file = join(cacheDir, `woke-${String(mentionId).replace(/[^A-Za-z0-9-]/g, '')}`);
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    writeFileSync(file, sessionId, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    try { return readFileSync(file, 'utf-8') === sessionId; } catch { return false; }
  }
}

/**
 * Store what a wake stands for under a new one-time ticket. Returns the
 * ticket, or null when it could not be stored (then the session is not woken).
 */
export function writeTicket(record) {
  const ticket = randomBytes(16).toString('hex');
  const file = join(cacheDir, `wake-ticket-${ticket}`);
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    return readFileSync(file, 'utf-8') === JSON.stringify(record) ? ticket : null;
  } catch {
    return null;
  }
}

export function dropTicket(ticket) {
  try { rmSync(join(cacheDir, `wake-ticket-${ticket}`), { force: true }); } catch {}
}

/**
 * Use up a ticket. Returns what it stands for, or null when there is no such
 * ticket. One that is there but cannot be read stands for the strictest wake.
 */
export function takeTicket(ticket) {
  if (!/^[a-f0-9]{32}$/.test(String(ticket))) return null;
  const file = join(cacheDir, `wake-ticket-${ticket}`);
  let raw;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    return { tier: 'reply', senders: [] };
  }
  try { rmSync(file, { force: true }); } catch {}
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return { tier: 'reply', senders: [] };
}

/**
 * Note which session a Claude Code process (the hooks' parent) is on, and read
 * it back. A waiter left over from before /clear uses this to see that its
 * session is no longer the one on screen.
 */
export function setCurrentSession(claudePid, sessionId) {
  return setMarker(`claude-${claudePid}`, 'current', sessionId);
}

export function currentSession(claudePid) {
  return readMarker(`claude-${claudePid}`, 'current');
}

/** Count one more allowed tool call in this woken turn; returns the count before it. */
export function countToolCall(sessionId) {
  const calls = toolCalls(sessionId);
  if (!setMarker(sessionId, 'calls', String(calls + 1))) throw new Error('tool count not written');
  return calls;
}

/** Tool calls allowed so far. A count that cannot be read counts as used up. */
export function toolCalls(sessionId) {
  const raw = readMarker(sessionId, 'calls');
  if (raw === null) return 0;
  return /^\d{1,6}$/.test(raw.trim()) ? Number(raw) : Number.MAX_SAFE_INTEGER;
}

/**
 * Whether Claude Code is set up to run the tool gate in this project: looks in
 * the user's settings and the project's for the PreToolUse hook. A settings
 * source this cannot see (managed settings, a plugin) reads as "no", which
 * only means the session is not woken.
 */
export function gateInstalled(cwd) {
  const userDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const files = [join(userDir, 'settings.json')];
  if (typeof cwd === 'string' && cwd) {
    files.push(join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json'));
  }
  return files.some((file) => {
    try { return hasGateHook(JSON.parse(readFileSync(file, 'utf-8'))); } catch { return false; }
  });
}

/** One line per wake and per tool decision in a woken turn. Never content. */
export function audit(entry) {
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const file = join(cacheDir, 'wake-audit.log');
    let fd = openSync(file, 'a', 0o600);
    try {
      // Keep one older file, so a burst of entries cannot erase the record.
      // The size is read from the open file, not looked up by name again.
      if (fstatSync(fd).size > AUDIT_MAX_BYTES) {
        closeSync(fd);
        fd = -1;
        renameSync(file, file + '.1');
        fd = openSync(file, 'a', 0o600);
      }
      appendFileSync(fd, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
    } finally {
      if (fd >= 0) closeSync(fd);
    }
  } catch {}
}

/** Remove marker and claim files nobody has touched for a week. */
export function pruneStale(now = Date.now()) {
  try {
    for (const name of readdirSync(cacheDir)) {
      if (!name.startsWith('sess-') && !name.startsWith('woke-') && !name.startsWith('wake-ticket-')) continue;
      // A session someone left woken stays restricted however long they are away.
      if (name.endsWith('.woken')) continue;
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
    const log = join(cacheDir, 'wake-audit.log');
    const read = (file) => { try { return readFileSync(file, 'utf-8'); } catch { return ''; } };
    for (const line of (read(log + '.1') + '\n' + read(log)).split('\n')) {
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
