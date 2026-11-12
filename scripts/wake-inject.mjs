// wake-inject.mjs — PostToolUse hook. Shows a message that arrived while the
// agent was in the middle of a turn, between two tool calls, instead of at the
// end of the turn.
//
// wake-wait.mjs leaves a `pending` note when a message arrives during a turn.
// Without that note this script reads one file and exits; it calls the server
// only when there is something to fetch.

import { readFileSync } from 'fs';
import { join } from 'path';
import { openClient, unwrap, cacheDir, readJson, readJsonBody, writeJson } from './hook-client.mjs';
import { normalizeState } from './check-work-plan.mjs';
import { formatWork } from './check-work-format.mjs';
import { safeSessionId } from './wake-lib.mjs';
import { hasMarker, clearMarker, readWoken } from './wake-session.mjs';

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf-8')) ?? {}; } catch {}
const sessionId = safeSessionId(input.session_id);
if (!sessionId || !hasMarker(sessionId, 'pending')) process.exit(0);
// A subagent's tool call is not the place to hand the main agent its mail.
if (input.agent_id) process.exit(0);
clearMarker(sessionId, 'pending');
// A turn that a message started is not shown more messages: they could come
// from anyone, and each one would keep an unattended turn going. They stay
// unread, for the next wake (allowlisted senders) or for the user.
if (readWoken(sessionId)) process.exit(0);

try {
  const client = openClient();
  if (!client) process.exit(0);
  const res = await client.get('/api/v2/work');
  if (!res.ok) process.exit(0);
  const payload = unwrap(await readJsonBody(res));

  const stateFile = join(cacheDir, `work-state-${client.agentName}.json`);
  const state = normalizeState(readJson(stateFile));
  const now = Date.now();
  const fresh = (Array.isArray(payload?.mentions) ? payload.mentions : [])
    .filter((m) => m?.mention_id && !(String(m.mention_id) in state.seen));
  if (!fresh.length) process.exit(0);
  for (const m of fresh) state.seen[String(m.mention_id)] = now;
  writeJson(stateFile, state);

  const text = 'A message arrived on AirChat while you were working. Finish what the user asked first unless the message changes it.\n\n'
    + formatWork({ mentions: fresh });
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }));
} catch {
  // Never get in the way of the tool call this hook follows.
}
process.exit(0);
