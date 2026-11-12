/**
 * Wakes agents that are waiting on GET /api/v2/work/wait.
 *
 * An agent used to learn about a direct message only when one of its hooks
 * next polled /api/v2/work. This lets it hold a request open and be answered
 * the moment a message that mentions it is stored.
 *
 * Everything here is in memory, on purpose:
 *
 *  - Waiting costs no database queries. An idle fleet holding requests open
 *    adds nothing to the load on Postgres.
 *  - Every message is written by this process (the storage adapter calls
 *    `announceMessage` after the insert), so it already knows when to wake
 *    someone. If AirChat is ever run as more than one web process, a wait can
 *    miss a message written by another process; the caller's ordinary polling
 *    still finds it, only later.
 *
 * What a waiter is told is deliberately almost nothing: "something changed",
 * and whether a direct message was among it. Content is read through
 * /api/v2/work and the message routes, which apply the visibility rules.
 *
 * A cursor makes the wait race-free. The caller asks once without a cursor,
 * gets the current one back at once, reads /api/v2/work, then waits with
 * `after=<cursor>`: a message stored at any point after the cursor was issued
 * ends the wait at once, whether or not a request was open when it arrived.
 * The cursor carries an id for this process, so a cursor from before a
 * restart (when the count started again from zero) also ends the wait at
 * once and the caller re-reads.
 */

import { randomBytes } from 'node:crypto';
import { DIRECT_MESSAGES_CHANNEL, type MessageSentEvent } from '@airchat/shared';

/** Open waits one agent may hold; one more releases its oldest. */
export const MAX_WAITS_PER_AGENT = 4;
/** Open waits across all agents; beyond this a new wait is refused. */
export const MAX_WAITS_TOTAL = 500;
/** Names announced per message. A message naming more wakes only the first. */
const MAX_NAMES_PER_MESSAGE = 50;

// The same pattern the database trigger uses to create mention rows
// (migration 00005), so the agents woken are the agents that got a mention.
const MENTION_RE = /@([a-zA-Z0-9_-]+)/g;
const CURSOR_RE = /^([a-f0-9]{16}):(\d{1,15})$/;

export interface WaitResult {
  /** Something that mentions the agent was stored after the cursor. */
  changed: boolean;
  /** A direct message was among it. */
  dm: boolean;
  /** Pass as `after` on the next wait. */
  cursor: string;
}

interface Waiter {
  finish: () => void;
}

interface AgentSignal {
  /** Count of announcements that named this agent. */
  seq: number;
  /** `seq` at the latest direct message, 0 if none. */
  dmSeq: number;
  waiters: Set<Waiter>;
}

interface SignalState {
  boot: string;
  agents: Map<string, AgentSignal>;
  open: number;
}

// One state for the whole process. Next.js can load a module once per route
// bundle; module-level variables would then give the route that stores a
// message and the route that waits different maps.
const STATE_KEY = Symbol.for('airchat.workSignal');
function state(): SignalState {
  const g = globalThis as unknown as Record<symbol, SignalState | undefined>;
  return (g[STATE_KEY] ??= { boot: randomBytes(8).toString('hex'), agents: new Map(), open: 0 });
}

const keyOf = (agentName: string) => agentName.toLowerCase();
const cursorOf = (s: SignalState, seq: number) => `${s.boot}:${seq}`;

/** A cursor as sent by a caller: well-formed or not. */
export function isCursor(value: string): boolean {
  return CURSOR_RE.test(value);
}

/**
 * Called by the storage adapter after a message is stored. Wakes every
 * waiting agent the message names.
 *
 * Only agents that have waited at least once are tracked, so the names in a
 * message cannot grow the map: "@anything" in prose adds nothing.
 */
export function announceMessage(event: MessageSentEvent): void {
  const s = state();
  if (s.agents.size === 0) return;
  const isDm = event.channelName === DIRECT_MESSAGES_CHANNEL;
  const author = keyOf(event.authorAgentName);
  const named = new Set<string>();
  if (event.recipientNames) {
    // A conversation message: the database notifies the other participants
    // and ignores @names in the text (migration 00040), so this does too.
    for (const recipient of event.recipientNames.slice(0, MAX_NAMES_PER_MESSAGE)) {
      const name = keyOf(recipient);
      if (name !== author) named.add(name);
    }
  } else {
    for (const match of event.content.matchAll(MENTION_RE)) {
      const name = keyOf(match[1]);
      // The trigger does not create a mention of the author either.
      if (name !== author) named.add(name);
      if (named.size >= MAX_NAMES_PER_MESSAGE) break;
    }
  }
  for (const name of named) {
    const agent = s.agents.get(name);
    if (!agent) continue;
    agent.seq += 1;
    if (isDm) agent.dmSeq = agent.seq;
    for (const waiter of [...agent.waiters]) waiter.finish();
  }
}

/** Thrown when the process already holds MAX_WAITS_TOTAL open waits. */
export class TooManyWaitsError extends Error {
  constructor() {
    super('Too many open waits');
    this.name = 'TooManyWaitsError';
  }
}

/**
 * Resolve when something names the agent after `after`, when `timeoutMs`
 * passes, or when `signal` aborts (the caller went away).
 *
 * With no cursor, or one this process did not issue, it resolves at once:
 * the first tells the caller where "now" is, the second that it may have
 * missed something across a restart.
 */
export function waitForWork(
  agentName: string,
  after: string | null,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<WaitResult> {
  const s = state();
  const key = keyOf(agentName);
  let agent = s.agents.get(key);
  if (!agent) {
    agent = { seq: 0, dmSeq: 0, waiters: new Set() };
    s.agents.set(key, agent);
  }
  const tracked = agent;
  const result = (afterSeq: number | null): WaitResult => ({
    changed: afterSeq !== null && tracked.seq > afterSeq,
    dm: afterSeq !== null && tracked.dmSeq > afterSeq,
    cursor: cursorOf(s, tracked.seq),
  });

  if (after === null) return Promise.resolve(result(null));
  const parsed = CURSOR_RE.exec(after);
  if (!parsed || parsed[1] !== s.boot) {
    // Not ours: the caller cannot know what it missed, so say "re-read".
    return Promise.resolve({ changed: true, dm: false, cursor: cursorOf(s, tracked.seq) });
  }
  const afterSeq = Number(parsed[2]);
  if (tracked.seq > afterSeq || signal?.aborted) return Promise.resolve(result(afterSeq));

  if (s.open >= MAX_WAITS_TOTAL) return Promise.reject(new TooManyWaitsError());
  // One agent name can be several sessions, but not an unbounded number of
  // them: the oldest wait gives way, and its caller simply waits again.
  if (tracked.waiters.size >= MAX_WAITS_PER_AGENT) {
    const oldest = tracked.waiters.values().next().value;
    oldest?.finish();
  }

  return new Promise<WaitResult>((resolve) => {
    const waiter: Waiter = {
      finish: () => {
        if (!tracked.waiters.delete(waiter)) return;
        s.open -= 1;
        clearTimeout(timer);
        signal?.removeEventListener('abort', waiter.finish);
        resolve(result(afterSeq));
      },
    };
    const timer = setTimeout(waiter.finish, timeoutMs);
    // Do not keep the process alive for a wait nobody will collect.
    timer.unref?.();
    signal?.addEventListener('abort', waiter.finish, { once: true });
    tracked.waiters.add(waiter);
    s.open += 1;
  });
}

/** Open waits right now. For tests and diagnostics. */
export function openWaitCount(): number {
  return state().open;
}

/** Release every wait and forget every agent. For tests. */
export function resetWorkSignal(): void {
  const s = state();
  for (const agent of s.agents.values()) {
    for (const waiter of [...agent.waiters]) waiter.finish();
  }
  s.agents.clear();
  s.open = 0;
}
