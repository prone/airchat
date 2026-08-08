/**
 * On-demand channel summaries.
 *
 * Summaries are REQUESTED (by a human in the dashboard or an agent via MCP),
 * not auto-created. Each request distills the channel's recent activity into a
 * single protected `channel-summary` note authored by the `summarizer` agent,
 * ledgers the token spend, and returns the note.
 *
 * Re-requesting returns the stored note unchanged when no message has arrived
 * since it was written — see freshSummary. Only new activity, a different
 * window or a different kind causes a regeneration.
 *
 * The generation reuses the unit-tested prompt in @airchat/shared/digest,
 * which frames message content as untrusted data (design doc §10.5).
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  buildDigestUserPrompt,
  buildProjectSummaryPrompt,
  DIGEST_SYSTEM_PROMPT,
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
  /** True when an existing note was returned without calling the model. */
  cached?: boolean;
}

/**
 * Return the stored summary when nothing has happened since it was written.
 *
 * A summary of unchanged content is unchanged, so regenerating it buys nothing
 * and costs an Anthropic request every time. That mattered more than it looks:
 * `summarize_channel` is in the connector's READ tool set, so a read-only token
 * could drive one billable generation per call up to the 120/min rate limit.
 * Reuse makes the common case — several agents catching up on the same quiet
 * channel — free and idempotent.
 *
 * Reuse requires an exact match on `window_days` and `kind`, because both
 * change what the summary covers. Anything else regenerates.
 *
 * Deliberately compares against the newest message rather than a wall-clock
 * TTL: activity, not elapsed time, is what makes a summary stale.
 */
async function freshSummary(
  channelId: string,
  channelName: string,
  slug: string,
  kind: SummaryKind,
  windowDays: number,
): Promise<ChannelSummaryResult | null> {
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

  // A different window or kind describes something else entirely.
  if (props?.window_days !== windowDays) return null;
  const storedKind = kind === 'project' ? 'project-summary' : 'channel-summary';
  if (props?.kind !== storedKind) return null;

  const { count } = await client
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('channel_id', channelId)
    .eq('quarantined', false)
    .gt('created_at', generatedAt);

  if ((count ?? 0) > 0) return null;

  return {
    channel: channelName,
    slug: note.slug,
    kind,
    body_md: note.body_md ?? '',
    message_count: typeof props?.message_count === 'number' ? props.message_count : 0,
    model: typeof props?.model === 'string' ? props.model : summaryModel(),
    input_tokens: 0,
    output_tokens: 0,
    generated_at: generatedAt,
    cached: true,
  };
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
  opts?: { windowDays?: number; kind?: SummaryKind; force?: boolean },
): Promise<ChannelSummaryResult> {
  if (!summariesEnabled()) {
    throw new SummaryError('Summaries are not configured (ANTHROPIC_API_KEY missing)', 503);
  }
  const client = getSupabaseClient();
  const kind: SummaryKind = opts?.kind ?? 'activity';
  const windowDays = opts?.windowDays ?? (kind === 'project' ? PROJECT_WINDOW_DAYS : DEFAULT_WINDOW_DAYS);

  const { data: channel } = await client.from('channels').select('id, name').eq('id', channelId).single();
  if (!channel) throw new SummaryError('Channel not found', 404);

  // Reuse an up-to-date summary rather than paying for an identical one.
  // `force` exists for a caller that genuinely wants a rewrite (a changed
  // prompt or model), which no current caller does.
  if (!opts?.force) {
    const cached = await freshSummary(channel.id, channel.name, SLUG_BY_KIND[kind], kind, windowDays);
    if (cached) return cached;
  }

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

  // Ledger spend regardless of outcome
  await client.from('llm_usage').insert({
    purpose: `channel-summary:${kind}`,
    channel_id: channelId,
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
  };
}
