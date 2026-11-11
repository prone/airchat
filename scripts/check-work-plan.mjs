// Decides what the check-work hook says, and how, for each hook event.
// Pure (no I/O) so it can be unit-tested; check-work.mjs does the reading,
// the request and the writing.
//
// The hook runs on three Claude Code events:
//
//   UserPromptSubmit  the user typed something. A message nobody has shown this
//                     agent yet is shown at once. The full reminder (every
//                     unread mention plus tasks) repeats at most once per
//                     REMINDER_INTERVAL_MS, so it does not land on every prompt.
//   SessionStart      a session opened or resumed: show everything waiting.
//   Stop              the agent finished its turn. If a message arrived while
//                     it was working, keep it going so it reads the message
//                     now rather than whenever the user next types.
//
// Stop is the one that can spend tokens with nobody watching, so it is the
// narrow one: unseen mentions only (never tasks, which stay open for hours and
// would hold the session open forever), never twice in one chain of stops, and
// a ceiling per hour so two agents answering each other cannot run unattended.

import { formatWork } from './check-work-format.mjs';

export const REMINDER_INTERVAL_MS = 5 * 60 * 1000;
export const MAX_STOP_PICKUPS_PER_HOUR = 6;
export const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const STOP_PREFACE = [
  'A message for you arrived on AirChat while you were working.',
  'If it asks you something you can answer, reply on AirChat (send_direct_message or send_message), then call mark_mentions_read. If it only acknowledges or thanks, mark it read and do not reply.',
  '',
  '',
].join('\n');

export function emptyState() {
  return { lastFull: 0, lastFailure: 0, seen: {}, stopPickups: [] };
}

/** Coerce whatever was on disk into a usable state object. */
export function normalizeState(raw) {
  const s = emptyState();
  if (!raw || typeof raw !== 'object') return s;
  if (Number.isFinite(raw.lastFull)) s.lastFull = raw.lastFull;
  if (Number.isFinite(raw.lastFailure)) s.lastFailure = raw.lastFailure;
  if (raw.seen && typeof raw.seen === 'object') {
    for (const [id, at] of Object.entries(raw.seen)) {
      if (Number.isFinite(at)) s.seen[id] = at;
    }
  }
  if (Array.isArray(raw.stopPickups)) s.stopPickups = raw.stopPickups.filter(Number.isFinite);
  return s;
}

/**
 * Whether to call the server at all. A Stop that is already the result of a
 * pickup never needs to; nothing does while the server is known to be failing.
 */
export function shouldRequest({ event, stopHookActive, state, now }) {
  if (event === 'Stop' && stopHookActive) return false;
  if (now - state.lastFailure < FAILURE_BACKOFF_MS) return false;
  return true;
}

/**
 * @returns {{ mode: 'none' | 'context' | 'block', text: string, state: object }}
 *   'context' — print text to stdout (added to the agent's context);
 *   'block'   — stop the agent from stopping, with text as the reason.
 */
export function plan({ event, payload, state, now, stopHookActive = false }) {
  const next = {
    lastFull: state.lastFull,
    lastFailure: 0,
    seen: Object.fromEntries(Object.entries(state.seen).filter(([, at]) => now - at < SEEN_TTL_MS)),
    stopPickups: state.stopPickups.filter((at) => now - at < HOUR_MS),
  };

  const mentions = Array.isArray(payload?.mentions) ? payload.mentions : [];
  const idOf = (m) => String(m?.mention_id ?? '');
  const fresh = mentions.filter((m) => idOf(m) && !(idOf(m) in next.seen));
  const markSeen = (list) => { for (const m of list) if (idOf(m)) next.seen[idOf(m)] = now; };

  if (event === 'Stop') {
    if (stopHookActive || !fresh.length || next.stopPickups.length >= MAX_STOP_PICKUPS_PER_HOUR) {
      return { mode: 'none', text: '', state: next };
    }
    markSeen(fresh);
    next.stopPickups.push(now);
    return { mode: 'block', text: STOP_PREFACE + formatWork({ mentions: fresh }), state: next };
  }

  const reminderDue = event === 'SessionStart' || now - state.lastFull >= REMINDER_INTERVAL_MS;
  if (reminderDue) {
    next.lastFull = now;
    markSeen(mentions);
    const text = formatWork(payload);
    return { mode: text ? 'context' : 'none', text, state: next };
  }

  if (fresh.length) {
    markSeen(fresh);
    return { mode: 'context', text: formatWork({ mentions: fresh }), state: next };
  }
  return { mode: 'none', text: '', state: next };
}

/**
 * The agent name this session has on the board. Must match deriveAgentName in
 * packages/mcp-server/src/utils.ts exactly: the MCP server posts under that
 * name, and the hook has to ask for mail addressed to the same one. Both
 * lower-case the name and turn anything outside a-z, 0-9 and "-" into a hyphen
 * (folder "My_Project" on machine "macbook" is macbook-my-project), and both
 * let AIRCHAT_PROJECT replace the folder name.
 */
export function hookAgentName(machineName, cwd, explicitProject) {
  const project = explicitProject || String(cwd).split(/[\\/]/).filter(Boolean).pop() || 'unknown';
  const sanitized = `${machineName}-${project}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
  return sanitized || machineName;
}
