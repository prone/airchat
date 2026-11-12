// wake-gate.mjs — PreToolUse hook. In a turn that a direct message started,
// refuses every tool the session's wake tier does not allow.
//
// Claude Code only blocks a tool when this hook says so. A hook that crashes,
// cannot load or runs out of time is ignored and the tool runs. So this file
// is written to give an answer whatever happens:
//
//   - it imports nothing but Node built-ins, so a missing or half-written
//     project file (mid-checkout, mid-install) cannot stop it loading. The
//     rules are loaded further down, inside a try;
//   - it decides whether the session is woken by itself, from the marker file;
//   - a timer refuses the tool well before Claude Code's own timeout would
//     kill the hook, and nothing here blocks the event loop for long, so the
//     timer can fire.
//
// What it cannot cover: the process being killed from outside (out of memory,
// kill -9) or Node itself failing to start. Then nothing is printed and
// Claude Code runs the tool. The README says so.
//
// It runs before every tool call, so the usual case (no woken turn) is one
// stat and exit. The rules are in wake-lib.mjs.

import { writeSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The same folder as hook-client.mjs's cacheDir, and the same id rule as
// wake-lib.mjs's safeSessionId: repeated here so this file needs neither.
const CACHE_DIR = join(homedir(), '.airchat', 'cache');
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
// The hook is installed with a 10 second timeout.
const ANSWER_WITHIN_MS = 5000;
const NOT_CHECKED = 'AirChat: this tool could not be checked, and this turn was started by a direct message, so it is refused.';

let answered = false;
/** Print the decision (a reason refuses the tool, null lets it run) and stop. */
function answer(reason) {
  if (answered) return;
  answered = true;
  if (reason) {
    const out = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    });
    try {
      writeSync(1, out + '\n');
    } catch {
      // stdout is gone; exit code 2 also blocks the tool.
      try { writeSync(2, reason + '\n'); } catch {}
      process.exit(2);
    }
  }
  process.exit(0);
}

// undefined: the hook input has not been read; null: it names no session.
let sessionId;

/**
 * Whether this may be a woken turn. Only a marker that is certainly absent
 * says no. Before the session is known, any session's marker counts.
 */
function mayBeWoken() {
  try {
    if (sessionId === null) return false;
    if (sessionId) { statSync(join(CACHE_DIR, `sess-${sessionId}.woken`)); return true; }
    return readdirSync(CACHE_DIR).some((name) => name.startsWith('sess-') && name.endsWith('.woken'));
  } catch (err) {
    return err?.code !== 'ENOENT';
  }
}

const giveUp = () => answer(mayBeWoken() ? NOT_CHECKED : null);
process.on('uncaughtException', giveUp);
process.on('unhandledRejection', giveUp);
setTimeout(giveUp, ANSWER_WITHIN_MS);

let raw = '';
process.stdin.setEncoding('utf-8');
for await (const chunk of process.stdin) raw += chunk;

let input = null;
try { input = JSON.parse(raw); } catch {}
// Input that cannot be read leaves the session unknown, which is the strict case.
if (input && typeof input === 'object') {
  sessionId = typeof input.session_id === 'string' && SESSION_ID_RE.test(input.session_id) ? input.session_id : null;
}

if (!mayBeWoken()) answer(null);

// From here the session is in a woken turn, so anything that goes wrong
// refuses the tool: a bug or a broken file must not open the gate.
try {
  if (!sessionId) throw new Error('no session');
  const { decide } = await import('./wake-gate-run.mjs');
  answer(await decide(input, sessionId));
} catch {
  answer(NOT_CHECKED);
}
