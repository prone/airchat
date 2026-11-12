// wake-gate-run.mjs — the tool gate's decision for one tool call in a woken
// turn. Loaded by wake-gate.mjs, which refuses the tool if this file or
// anything it imports cannot be loaded, throws, or takes too long.

import { realpath, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { gateDecision } from './wake-lib.mjs';
import { readWoken, audit, toolCalls, countToolCall } from './wake-session.mjs';

/**
 * @returns the reason the tool is refused, or null when it may run.
 */
export async function decide(input, sessionId) {
  const woken = readWoken(sessionId);
  if (!woken) return null;
  const limited = woken.tier !== 'act';

  // The file system is asked here, without blocking, so a slow disk cannot
  // hold up the timer in wake-gate.mjs. The rules themselves stay pure.
  const real = new Map();
  const links = new Map();
  if (limited && input?.tool_name === 'Read') {
    const filePath = input?.tool_input?.file_path;
    for (const path of [filePath, input?.cwd]) {
      if (typeof path !== 'string' || !path) continue;
      try { real.set(path, await realpath(path)); } catch {}
    }
    const target = real.get(filePath);
    if (target) {
      try {
        const stat = await lstat(target);
        if (stat.isFile()) links.set(target, stat.nlink);
      } catch {}
    }
  }

  const decision = gateDecision(woken, input, (path) => real.get(path) ?? null, {
    home: homedir(),
    calls: limited ? toolCalls(sessionId) : 0,
    linksOf: (path) => links.get(path) ?? null,
  });
  if (decision.allow && limited) countToolCall(sessionId);
  audit({ event: decision.allow ? 'tool-allowed' : 'tool-refused', session: sessionId, tool: String(input?.tool_name ?? '') });
  return decision.allow ? null : decision.reason;
}
