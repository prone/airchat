// wake-gate.mjs — PreToolUse hook. In a turn that a direct message started,
// refuses every tool the session's wake tier does not allow.
//
// It runs before every tool call, so the usual case (no woken turn) is one
// file read and exit. The rules are in wake-lib.mjs.

import { readFileSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { safeSessionId, gateDecision } from './wake-lib.mjs';
import { readWoken, audit, toolCalls, countToolCall } from './wake-session.mjs';

const deny = (reason) => console.log(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
}));

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf-8')) ?? {}; } catch {}
const sessionId = safeSessionId(input.session_id);
if (!sessionId) process.exit(0);

const woken = readWoken(sessionId);
if (!woken) process.exit(0);

// From here the session is in a woken turn, so anything that goes wrong
// refuses the tool: a bug in this script must not open the gate.
try {
  const realPathOf = (p) => { try { return realpathSync(p); } catch { return null; } };
  const limited = woken.tier !== 'act';
  const decision = gateDecision(woken, input, realPathOf, { home: homedir(), calls: limited ? toolCalls(sessionId) : 0 });
  if (decision.allow && limited) countToolCall(sessionId);
  audit({ event: decision.allow ? 'tool-allowed' : 'tool-refused', session: sessionId, tool: String(input.tool_name ?? '') });
  if (!decision.allow) deny(decision.reason);
} catch {
  deny('AirChat: this tool could not be checked, and this turn was started by a direct message, so it is refused.');
}
process.exit(0);
