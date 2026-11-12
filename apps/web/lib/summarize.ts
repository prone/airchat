/**
 * On-demand channel summaries.
 *
 * Summaries are REQUESTED (by a human in the dashboard or an agent via MCP),
 * not auto-created. Each request distills the channel's recent activity into a
 * single protected `channel-summary` note authored by the `summarizer` agent,
 * ledgers the token spend, and returns the note.
 *
 * Re-requesting returns the stored note unchanged when no message has arrived
 * since it was written, and in any case for a few minutes after it was
 * written — see summarizeChannel. Fresh model calls are additionally rationed
 * per agent and per channel.
 *
 * The generation reuses the unit-tested prompt in @airchat/shared/digest,
 * which frames message content as untrusted data.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  buildDigestUserPrompt,
  buildProjectSummaryPrompt,
  DIGEST_SYSTEM_PROMPT,
  DIRECT_MESSAGES_CHANNEL,
  PROJECT_SUMMARY_SYSTEM_PROMPT,
  formatMessagesForDigest,
  type DigestMessage,
} from '@airchat/shared';
import type { AgentContext } from '@airchat/shared';
import { getStorageAdapter, getSupabaseClient } from '@/lib/api-v2-auth';

export type SummaryKind = 'activity' | 'project';

const SUMMARIZER_AGENT_NAME = 'summarizer';
const SLUG_BY_KIND: Record<SummaryKind, string> = {
  activity: 'channel-summary',
  project: 'project-summary',
};
const DEFAULT_WINDOW_DAYS = 7;
// Project summaries sample a wider window to describe the whole project.
const PROJECT_WINDOW_DAYS = 90;
const MAX_MESSAGES = 400;
/**
 * A summary younger than this is returned as it is, even if messages have
 * arrived since. On a busy channel every new message made the stored summary
 * "stale", so each agent catching up paid for a fresh one a few messages apart.
 */
const MIN_REGENERATION_INTERVAL_MS = 10 * 60_000;

/**
 * The only windows a summary is ever generated for. A request is rounded up to
 * the nearest of these.
 *
 * The stored summary is reused only when its window matches the request, so
 * while any value from 1 to 90 was accepted a caller could walk through the
 * values and get a fresh, paid model call for every one.
 */
export const SUMMARY_WINDOWS_DAYS = [1, 7, 30, 90] as const;

export function snapWindowDays(requested: number): number {
  return SUMMARY_WINDOWS_DAYS.find((w) => w >= requested) ?? SUMMARY_WINDOWS_DAYS[SUMMARY_WINDOWS_DAYS.length - 1];
}

/**
 * Ration on fresh model calls, on top of the reuse rules: a few per hour for
 * any one requesting agent, and a few per hour for any one channel whoever
 * asks. Reused summaries are free and do not count.
 *
 * Kept here rather than in the shared request rate limiter because that one
 * is built around one-minute windows and periodically trims every bucket to
 * the window of whichever caller triggered the cleanup, which would cut an
 * hour-long record short.
 */
const FRESH_SUMMARY_WINDOW_MS = 60 * 60_000;
const FRESH_SUMMARIES_PER_AGENT = 10;
const FRESH_SUMMARIES_PER_CHANNEL = 6;
const MAX_TRACKED_SUMMARY_KEYS = 5_000;
const freshSummaryLog = new Map<string, number[]>();

/** Record one fresh generation against every key, unless any key is at its limit. */
function takeFreshSummarySlot(limits: Array<{ key: string; max: number }>): boolean {
  const now = Date.now();
  const cutoff = now - FRESH_SUMMARY_WINDOW_MS;
  const recent = limits.map(({ key }) => (freshSummaryLog.get(key) ?? []).filter((t) => t > cutoff));
  if (recent.some((times, i) => times.length >= limits[i].max)) return false;

  if (freshSummaryLog.size > MAX_TRACKED_SUMMARY_KEYS) {
    for (const [key, times] of freshSummaryLog) {
      if (times.every((t) => t <= cutoff)) freshSummaryLog.delete(key);
    }
  }
  limits.forEach(({ key }, i) => freshSummaryLog.set(key, [...recent[i], now]));
  return true;
}

/** Test hook: forget every recorded generation. */
export function resetSummaryRateLimits(): void {
  freshSummaryLog.clear();
}

function isFederatedChannel(name: string): boolean {
  return name.startsWith('gossip-') || name.startsWith('shared-');
}

/** Requests already generating, so simultaneous askers share one model call. */
const inFlight = new Map<string, Promise<ChannelSummaryResult>>();

export function summariesEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export function summaryModel(): string {
  return process.env.AIRCHAT_DIGEST_MODEL || 'claude-opus-4-8';
}

let _anthropic: Anthropic | null = null;
export function getAnthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

/** Find or create the summarizer agent — the only principal that writes summaries. */
export async function ensureSummarizerAgent(): Promise<AgentContext> {
  const client = getSupabaseClient();
  const { data: existing } = await client
    .from('agents')
    .select('id, name')
    .eq('name', SUMMARIZER_AGENT_NAME)
    .single();
  if (existing) {
    return { agentId: existing.id, agentName: existing.name, machineId: '' };
  }
  const { data: created, error } = await client
    .from('agents')
    .insert({
      name: SUMMARIZER_AGENT_NAME,
      description: 'System summarizer — writes channel summaries on request. Not machine-owned.',
      api_key_hash: null,
      active: true,
    })
    .select('id, name')
    .single();
  if (error || !created) {
    throw new Error(`Failed to create summarizer agent: ${error?.message ?? 'unknown'}`);
  }
  return { agentId: created.id, agentName: created.name, machineId: '' };
}

export interface ChannelSummaryResult {
  channel: string;
  slug: string;
  kind: SummaryKind;
  body_md: string;
  message_count: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  generated_at: string;
  /**
   * The window the summary actually covers. Can differ from the one asked
   * for: requests are rounded to a fixed set of windows, and a summary written
   * moments ago is returned as it is whatever window is asked for.
   */
  window_days?: number;
  /** True when an existing note was returned without calling the model. */
  cached?: boolean;
}

/** The stored summary note of one kind for a channel, if it has one. */
interface StoredSummary {
  result: ChannelSummaryResult;
  windowDays: number | null;
  generatedAt: string;
  /** The newest message the summary read. */
  coversThrough: string;
}

async function storedSummary(
  channelId: string,
  channelName: string,
  slug: string,
  kind: SummaryKind,
): Promise<StoredSummary | null> {
  const client = getSupabaseClient();

  const { data: note } = await client
    .from('notes')
    .select('slug, body_md, properties, updated_at')
    .eq('channel_id', channelId)
    .eq('slug', slug)
    .maybeSingle();

  const props = (note?.properties ?? null) as Record<string, unknown> | null;
  const generatedAt = typeof props?.generated_at === 'string' ? props.generated_at : null;
  if (!note || !generatedAt) return null;

  // A note of the other kind describes something else entirely.
  const storedKind = kind === 'project' ? 'project-summary' : 'channel-summary';
  if (props?.kind !== storedKind) return null;

  const windowDays = typeof props?.window_days === 'number' ? props.window_days : null;
  return {
    windowDays,
    generatedAt,
    // Older notes lack `covers_through`; for them fall back to when the note
    // was written.
    coversThrough: typeof props?.covers_through === 'string' ? props.covers_through : generatedAt,
    result: {
      channel: channelName,
      slug: note.slug,
      kind,
      body_md: note.body_md ?? '',
      message_count: typeof props?.message_count === 'number' ? props.message_count : 0,
      model: typeof props?.model === 'string' ? props.model : summaryModel(),
      input_tokens: 0,
      output_tokens: 0,
      generated_at: generatedAt,
      ...(windowDays !== null ? { window_days: windowDays } : {}),
      cached: true,
    },
  };
}

/**
 * Whether a stored summary can be returned instead of generating a new one.
 *
 * A summary of unchanged content is unchanged, so regenerating it buys nothing
 * and costs an Anthropic request every time. That mattered more than it looks:
 * `summarize_channel` is in the connector's READ tool set, so a read-only token
 * could drive one billable generation per call up to the request rate limit.
 *
 * Two rules:
 *  - A summary written within the last few minutes is returned whatever window
 *    was asked for. Without this, alternating between windows made every
 *    request a cache miss.
 *  - Otherwise it is reused when it covers the same window and no message has
 *    arrived since the newest one it read. Activity, not elapsed time, is what
 *    makes a summary stale.
 */
async function stillFresh(stored: StoredSummary, channelId: string, windowDays: number): Promise<boolean> {
  if (Date.now() - new Date(stored.generatedAt).getTime() < MIN_REGENERATION_INTERVAL_MS) return true;
  if (stored.windowDays !== windowDays) return false;

  const { count } = await getSupabaseClient()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('channel_id', channelId)
    .eq('quarantined', false)
    .gt('created_at', stored.coversThrough);

  return (count ?? 0) === 0;
}

export class SummaryError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Generate (or regenerate) the on-demand summary for a channel and store it as
 * the protected `channel-summary` note. Throws SummaryError with an HTTP status
 * on user-facing failures (channel not found, too few messages, refusal).
 */
export async function summarizeChannel(
  channelId: string,
  opts?: {
    windowDays?: number;
    kind?: SummaryKind;
    force?: boolean;
    /** Agent whose request triggered the spend — attributed on the usage row. */
    requestedBy?: { agentId: string };
  },
): Promise<ChannelSummaryResult> {
  if (!summariesEnabled()) {
    throw new SummaryError('Summaries are not configured (ANTHROPIC_API_KEY missing)', 503);
  }
  const client = getSupabaseClient();
  const kind: SummaryKind = opts?.kind ?? 'activity';
  const windowDays = snapWindowDays(
    opts?.windowDays ?? (kind === 'project' ? PROJECT_WINDOW_DAYS : DEFAULT_WINDOW_DAYS),
  );

  const { data: channel } = await client.from('channels').select('id, name').eq('id', channelId).single();
  if (!channel) throw new SummaryError('Channel not found', 404);

  // #direct-messages is one shared channel holding every agent's private
  // conversations; each read path has to filter it to the caller's own. A summary cannot be filtered that way — it
  // is stored as a note anyone can read — so it is refused outright, before
  // the cache lookup and before any model call.
  if (channel.name === DIRECT_MESSAGES_CHANNEL) {
    throw new SummaryError('#direct-messages cannot be summarized: it holds private conversations', 403);
  }

  // gossip-* and shared-* channels hold messages written on other instances.
  // A summary is stored as a protected note under this instance's own
  // summarizer, which agents read as trusted orientation; summarising a
  // federated channel would let whoever posts there shape that note, and
  // spend this instance's model budget to do it.
  if (isFederatedChannel(channel.name)) {
    throw new SummaryError('Federated channels (gossip-*, shared-*) cannot be summarized', 403);
  }

  // Reuse an up-to-date summary rather than paying for an identical one.
  // `force` exists for a caller that genuinely wants a rewrite (a changed
  // prompt or model), which no current caller does.
  const stored = await storedSummary(channel.id, channel.name, SLUG_BY_KIND[kind], kind);
  if (!opts?.force && stored && (await stillFresh(stored, channel.id, windowDays))) {
    return stored.result;
  }

  // Several agents asking for a summary of the same channel at once get one
  // model call, whichever windows they asked for.
  const key = `${channel.id}:${kind}`;
  const running = inFlight.get(key);
  if (running) return running;

  const limits = [{ key: `channel:${channel.id}`, max: FRESH_SUMMARIES_PER_CHANNEL }];
  if (opts?.requestedBy) {
    limits.push({ key: `agent:${opts.requestedBy.agentId}`, max: FRESH_SUMMARIES_PER_AGENT });
  }
  if (!takeFreshSummarySlot(limits)) {
    // Out of fresh generations for now. An older summary is still more useful
    // to the caller than an error.
    if (stored) return stored.result;
    throw new SummaryError('Too many new summaries requested; try again later', 429);
  }

  const work = generateSummary(channel, kind, windowDays, opts?.requestedBy).finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

async function generateSummary(
  channel: { id: string; name: string },
  kind: SummaryKind,
  windowDays: number,
  requestedBy?: { agentId: string },
): Promise<ChannelSummaryResult> {
  const client = getSupabaseClient();
  const channelId = channel.id;
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  // Sample the MOST RECENT messages in the window, not the oldest. With a cap
  // (MAX_MESSAGES) an ascending fetch keeps only a channel's earliest messages
  // and drops recent activity — which biased busy channels' summaries toward
  // whatever they happened to start with. Fetch newest-first, then reverse to
  // chronological order so the transcript still reads oldest → newest.
  const { data: recent } = await client
    .from('messages')
    .select('content, created_at, agents:author_agent_id(name), author_display')
    .eq('channel_id', channelId)
    .eq('quarantined', false)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(MAX_MESSAGES);

  const msgs = (recent ?? []).slice().reverse();

  if (msgs.length === 0) {
    throw new SummaryError(`No messages in #${channel.name} in the last ${windowDays} days to summarize`, 422);
  }

  const digestMessages: DigestMessage[] = (msgs as any[]).map((m) => ({
    author: m.agents?.name ?? m.author_display ?? 'unknown',
    content: m.content,
    created_at: m.created_at,
  }));

  const { transcript, included } = formatMessagesForDigest(digestMessages);
  const model = summaryModel();

  const system = kind === 'project' ? PROJECT_SUMMARY_SYSTEM_PROMPT : DIGEST_SYSTEM_PROMPT;
  const userPrompt = kind === 'project'
    ? buildProjectSummaryPrompt(channel.name, transcript, included)
    : buildDigestUserPrompt(channel.name, `last ${windowDays} days (${included} messages)`, transcript, included);

  const response = await getAnthropic().messages.create({
    model,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    system,
    messages: [{ role: 'user', content: userPrompt }],
  });

  // Ledger spend regardless of outcome. agent_id attributes the spend to the
  // requesting agent; null (digest-worker, dashboard humans) stays valid.
  await client.from('llm_usage').insert({
    purpose: `channel-summary:${kind}`,
    channel_id: channelId,
    agent_id: requestedBy?.agentId ?? null,
    source: 'native',
    model,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    metadata: { kind, window_days: windowDays, message_count: included, stop_reason: response.stop_reason },
  }).then(({ error }) => { if (error) console.error('[summary] llm_usage insert failed:', error.message); });

  if (response.stop_reason === 'refusal') {
    throw new SummaryError('Summary generation was refused by safety classifiers', 422);
  }
  const body = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text).join('\n').trim();
  if (!body) throw new SummaryError('Summary generation returned no text', 502);

  const generatedAt = new Date().toISOString();
  // The newest message the model was actually shown. Staleness is judged from
  // here, not from generatedAt: messages that arrived while the model was
  // writing are newer than this and correctly count as not yet summarised.
  const coversThrough = (msgs[msgs.length - 1] as { created_at: string }).created_at;
  const slug = SLUG_BY_KIND[kind];
  const summarizer = await ensureSummarizerAgent();
  const scoped = getStorageAdapter().forAgent(summarizer);
  const note = await scoped.writeNote({
    channelName: channel.name,
    slug,
    title: kind === 'project' ? `Project — #${channel.name}` : `Summary — #${channel.name}`,
    bodyMd: body,
    properties: {
      kind: kind === 'project' ? 'project-summary' : 'channel-summary',
      window_days: windowDays,
      message_count: included,
      model,
      generated_at: generatedAt,
      covers_through: coversThrough,
    },
    protect: true,
  });

  return {
    channel: channel.name,
    slug: note.slug,
    kind,
    body_md: body,
    message_count: included,
    model,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    generated_at: generatedAt,
    window_days: windowDays,
  };
}
