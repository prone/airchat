import { plan, shouldRequest, normalizeState } from './check-work-plan.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { openClient, unwrap, cacheDir, readJson, writeJson } from './hook-client.mjs';
import { safeSessionId, isTypedPrompt, wakeTickets, ticketRecord } from './wake-lib.mjs';
import { setMarker, clearMarker, readWoken, wokenSummary, takeTicket } from './wake-session.mjs';

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
//
// The waiter marks its session woken before it sends a wake, but that alone
// is not enough, for two reasons. A wake and a typed prompt can cross: the
// person's prompt lands a moment after the mark and lifts it, and the wake's
// own turn starts after theirs. And after /clear the wake of a waiter started
// under the old session id arrives in a session with a new one. So every wake
// carries a one-time ticket in its text, and the prompt that delivers it
// switches the restriction on for the session it is in.
const sessionId = safeSessionId(hookInput.session_id);
let inWokenTurn = false;
if (sessionId) {
  if (event === 'UserPromptSubmit') {
    setMarker(sessionId, 'busy');
    // A prompt that carries a stored ticket is a wake, however it is wrapped:
    // this does not rely on Claude Code putting a tag in front of it.
    const tickets = wakeTickets(hookInput.prompt).map(takeTicket).filter(Boolean);
    for (const record of tickets) {
      // If the mark cannot be written, leave one that reads as damaged,
      // which the gate treats as the strictest wake.
      if (!setMarker(sessionId, 'woken', ticketRecord(record, Date.now(), readWoken(sessionId)))) setMarker(sessionId, 'woken', '!');
    }
    if (!tickets.length && isTypedPrompt(hookInput.prompt)) {
      const woken = readWoken(sessionId);
      if (woken) {
        clearMarker(sessionId, 'woken');
        clearMarker(sessionId, 'calls');
        const summary = wokenSummary(sessionId, woken);
        if (summary) console.log(summary + '\n');
      }
    }
  } else if (event === 'Stop' || hookInput.source !== 'compact') {
    // SessionStart also fires when a running turn compacts its context; the
    // turn is still running then.
    clearMarker(sessionId, 'busy');
  }
  inWokenTurn = readWoken(sessionId) !== null;
}
// A turn that a message started is shown nothing by this hook, at its start,
// at its end or in between. The wake itself carries the messages that caused
// it, from senders on the allowlist. Everything else unread could be from
// anyone, and could be private: a conversation message, or a direct message
// from an agent that may not wake this session. Printing it here would put
// that text into a turn that may answer the sender who woke it, and would
// hand the turn instructions from agents the allowlist was meant to keep out.
// It stays unread and is shown when a person next types. The waiter that
// starts at the end of the turn checks for more from allowlisted senders,
// within the hourly limit.
if (inWokenTurn) process.exit(0);

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
