import { plan, shouldRequest, normalizeState } from './check-work-plan.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { openClient, unwrap, cacheDir, readJson, writeJson } from './hook-client.mjs';
import { safeSessionId, isTypedPrompt } from './wake-lib.mjs';
import { setMarker, clearMarker, readWoken, wokenSummary } from './wake-session.mjs';

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

// ── Turn tracking for the wake hooks ────────────────────────────────────────
// wake-wait.mjs must not start a turn while one is running, and wake-gate.mjs
// restricts a turn that a message started until a person types again. This
// hook sees both ends of every turn, so it keeps those two facts. It runs
// before anything that can exit early: they have to be right even when the
// server is unreachable.
const sessionId = safeSessionId(hookInput.session_id);
if (sessionId) {
  if (event === 'UserPromptSubmit') {
    setMarker(sessionId, 'busy');
    const woken = readWoken(sessionId);
    if (woken && isTypedPrompt(hookInput.prompt)) {
      clearMarker(sessionId, 'woken');
      const summary = wokenSummary(sessionId, woken);
      if (summary) console.log(summary + '\n');
    }
  } else {
    clearMarker(sessionId, 'busy');
  }
}

// ── Config, key and agent name ──────────────────────────────────────────────
const client = openClient();
if (!client) process.exit(0);
const { agentName } = client;

// ── State — PER AGENT ───────────────────────────────────────────────────────
//
// What this agent has already been shown, and when. It is per agent on
// purpose: an earlier version kept one timer for the whole machine, so the
// first agent to check silenced every other agent for five minutes — a session
// in another project produced nothing at all until the file was deleted by
// hand.
const stateFile = join(cacheDir, `work-state-${agentName}.json`);
const state = normalizeState(readJson(stateFile));
const saveState = (next) => writeJson(stateFile, next);

const now = Date.now();
if (!shouldRequest({ event, stopHookActive, state, now })) process.exit(0);

// The hook now asks the server on every prompt, so an unreachable server must
// not cost every prompt a timeout: one failure pauses the hook for a while.
function noteFailure() {
  saveState({ ...state, lastFailure: now });
}

// ── Main ────────────────────────────────────────────────────────────────────

try {
  const res = await client.get('/api/v2/work');

  if (!res.ok) {
    if (res.status >= 500 || res.status === 429) noteFailure();
    process.exit(0);
  }

  const payload = unwrap(await res.json());

  const result = plan({ event, payload, state, now, stopHookActive });
  saveState(result.state);
  if (result.mode === 'block') {
    // The agent keeps going, so the turn is not over.
    if (sessionId) setMarker(sessionId, 'busy');
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
