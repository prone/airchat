// wake-wait.mjs — waits for a direct message and wakes an idle session.
//
// Wired to Claude Code's Stop and SessionStart events with `asyncRewake`: it
// runs in the background while the session sits idle, and exiting with code 2
// starts a turn with what it wrote to stderr. It holds
// GET /api/v2/work/wait open, so a message reaches the session when it is
// stored, not when the user next types.
//
// It does nothing unless ~/.airchat/config turns waking on (AIRCHAT_WAKE),
// and it wakes only for a direct message from a sender on the allowlist
// (AIRCHAT_WAKE_FROM). What the woken turn may do is enforced by
// wake-gate.mjs; see wake-lib.mjs for the rules.

import { readFileSync } from 'fs';
import { join } from 'path';
import { openClient, unwrap, cacheDir, readJson, writeJson } from './hook-client.mjs';
import { normalizeState } from './check-work-plan.mjs';
import { formatWork } from './check-work-format.mjs';
import { homedir } from 'os';
import { wakeSettings, wakeCandidates, wakeBudget, wakePreface, wokenRecord, projectFolder, safeSessionId } from './wake-lib.mjs';
import {
  setMarker, clearMarker, hasMarker, readWoken, claimWaiter, claimMention, gateInstalled, audit, pruneStale, readMarker,
} from './wake-session.mjs';

const WAIT_SECONDS = 50;
// Stop waiting after this long; the next Stop or SessionStart starts another.
const MAX_LIFETIME_MS = 12 * 60 * 60 * 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

let hookInput = {};
try { hookInput = JSON.parse(readFileSync(0, 'utf-8')) ?? {}; } catch {}
const sessionId = safeSessionId(hookInput.session_id);
if (!sessionId) process.exit(0);

const client = openClient();
if (!client) process.exit(0);
const settings = wakeSettings(client.config, client.agentName);
if (!settings.listens) process.exit(0);

// One waiter per session. Every Stop runs this script; without the claim each
// turn would leave another process holding a request open.
if (!claimWaiter(sessionId)) process.exit(0);
pruneStale();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const stillMine = () => Number(readMarker(sessionId, 'waiter')) === process.pid;
const stateFile = join(cacheDir, `work-state-${client.agentName}.json`);
const wakeFile = join(cacheDir, `wake-state-${client.agentName}.json`);

/** Ask the server once; null on any failure (the caller backs off). */
async function ask(after) {
  const query = after ? `?after=${encodeURIComponent(after)}&timeout=${WAIT_SECONDS}` : '';
  const res = await client.get(`/api/v2/work/wait${query}`, (WAIT_SECONDS + 15) * 1000);
  // 503: waiting is turned off on the server, or it is full. 404: a server
  // from before this endpoint. Either way there is nothing to wait on.
  if (res.status === 503 || res.status === 404) return { gone: true };
  if (!res.ok) return null;
  return unwrap(await res.json());
}

/**
 * A message arrived. Wake the session if it is idle and the message is from
 * an allowlisted sender; if a turn is running, leave a note for wake-inject.
 * Returns only when there is nothing to wake for.
 */
async function onChange() {
  if (hasMarker(sessionId, 'busy')) {
    setMarker(sessionId, 'pending');
    return;
  }
  if (!settings.wakes) return;

  const res = await client.get('/api/v2/work');
  if (!res.ok) return;
  const payload = unwrap(await res.json());
  const state = normalizeState(readJson(stateFile));
  const candidates = wakeCandidates(payload?.mentions, settings, state.seen)
    .filter((m) => claimMention(m.mention_id, sessionId));
  if (!candidates.length) return;

  const now = Date.now();
  const budget = wakeBudget(readJson(wakeFile, {})?.wakes, now);
  const senders = [...new Set(candidates.map((m) => String(m.from).toLowerCase()))];
  // Not waking leaves the message unread; it is shown when the user next
  // types, as it would be with waking off.
  const skip = (reason) => audit({ event: 'wake-skipped', reason, session: sessionId, agent: client.agentName, senders });
  if (!budget.allowed) return skip('hourly limit');
  if (settings.tier !== 'act' && !gateInstalled(hookInput.cwd)) return skip('tool gate hook not installed');
  if (settings.tier !== 'act' && !projectFolder(hookInput.cwd, homedir())) return skip('session is not in a project folder');

  // Mark the session woken BEFORE anything else, and check it took: the gate
  // reads this file, so a wake without it would be an unrestricted turn.
  const earlier = readMarker(sessionId, 'woken');
  const record = wokenRecord(settings.tier, senders, now, readWoken(sessionId));
  const marked = setMarker(sessionId, 'due', record) && setMarker(sessionId, 'woken', record)
    && readMarker(sessionId, 'woken') === JSON.stringify(record);
  const undo = () => {
    clearMarker(sessionId, 'due');
    if (earlier === null) clearMarker(sessionId, 'woken'); else setMarker(sessionId, 'woken', earlier);
  };
  if (!marked) { undo(); return skip('marker not written'); }
  // A person may have started a turn while this was asking the server. Their
  // turn must not be restricted: take the mark back and hand over to
  // wake-inject.
  if (hasMarker(sessionId, 'busy')) { undo(); setMarker(sessionId, 'pending'); return; }

  clearMarker(sessionId, 'calls');
  for (const m of candidates) state.seen[String(m.mention_id)] = now;
  writeJson(stateFile, state);
  writeJson(wakeFile, { wakes: [...budget.recent, now] });
  audit({ event: 'wake', session: sessionId, agent: client.agentName, tier: settings.tier, senders, messages: candidates.length });

  process.stderr.write(wakePreface(settings.tier) + formatWork({ mentions: candidates }) + '\n');
  process.exit(2);
}

let cursor = null;
let backoff = 2000;
while (Date.now() - started < MAX_LIFETIME_MS && stillMine()) {
  try {
    const answer = await ask(cursor);
    if (answer?.gone) process.exit(0);
    if (!answer || typeof answer.cursor !== 'string') throw new Error('no answer');
    backoff = 2000;
    const first = cursor === null;
    cursor = answer.cursor;
    // The first answer only says where "now" is. Anything already unread is
    // the Stop hook's to show; it runs alongside this script. The exception
    // is a session still in a woken state: the Stop hook shows it nothing, so
    // messages that arrived during the woken turn are looked for here.
    if (first ? readWoken(sessionId) !== null : answer.changed) await onChange();
  } catch {
    await sleep(backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}
process.exit(0);
