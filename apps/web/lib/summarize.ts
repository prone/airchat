/**
 * On-demand channel summaries.
 *
 * Summaries are REQUESTED (by a human in the dashboard or an agent via MCP),
 * not auto-created. Each request distills the channel's recent activity into a
 * single protected `channel-summary` note authored by the `summarizer` agent,
 * ledgers the token spend, and returns the note. Re-requesting regenerates it.
 *
 * The generation reuses the unit-tested prompt in @airchat/shared/digest,
 * which frames message content as untrusted data (design doc §10.5).
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  buildDigestUserPrompt,
  DIGEST_SYSTEM_PROMPT,
  formatMessagesForDigest,
  type DigestMessage,
} from '@airchat/shared';
import type { AgentContext } from '@airchat/shared';
import { getStorageAdapter, getSupabaseClient } from '@/lib/api-v2-auth';

const SUMMARIZER_AGENT_NAME = 'summarizer';
const SUMMARY_SLUG = 'channel-summary';
const DEFAULT_WINDOW_DAYS = 7;
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
  body_md: string;
  message_count: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  generated_at: string;
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
export async function summarizeChannel(channelId: string, opts?: { windowDays?: number }): Promise<ChannelSummaryResult> {
  if (!summariesEnabled()) {
    throw new SummaryError('Summaries are not configured (ANTHROPIC_API_KEY missing)', 503);
  }
  const client = getSupabaseClient();
  const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;

  const { data: channel } = await client.from('channels').select('id, name').eq('id', channelId).single();
  if (!channel) throw new SummaryError('Channel not found', 404);

  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const { data: msgs } = await client
    .from('messages')
    .select('content, created_at, agents:author_agent_id(name), author_display')
    .eq('channel_id', channelId)
    .eq('quarantined', false)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(MAX_MESSAGES);

  if (!msgs || msgs.length === 0) {
    throw new SummaryError(`No messages in #${channel.name} in the last ${windowDays} days to summarize`, 422);
  }

  const digestMessages: DigestMessage[] = (msgs as any[]).map((m) => ({
    author: m.agents?.name ?? m.author_display ?? 'unknown',
    content: m.content,
    created_at: m.created_at,
  }));

  const { transcript, included } = formatMessagesForDigest(digestMessages);
  const windowLabel = `last ${windowDays} days (${included} messages)`;
  const model = summaryModel();

  const response = await getAnthropic().messages.create({
    model,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    system: DIGEST_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildDigestUserPrompt(channel.name, windowLabel, transcript, included) }],
  });

  // Ledger spend regardless of outcome
  await client.from('llm_usage').insert({
    purpose: 'channel-summary',
    channel_id: channelId,
    model,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    metadata: { window_days: windowDays, message_count: included, stop_reason: response.stop_reason },
  }).then(({ error }) => { if (error) console.error('[summary] llm_usage insert failed:', error.message); });

  if (response.stop_reason === 'refusal') {
    throw new SummaryError('Summary generation was refused by safety classifiers', 422);
  }
  const body = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text).join('\n').trim();
  if (!body) throw new SummaryError('Summary generation returned no text', 502);

  const generatedAt = new Date().toISOString();
  const summarizer = await ensureSummarizerAgent();
  const scoped = getStorageAdapter().forAgent(summarizer);
  const note = await scoped.writeNote({
    channelName: channel.name,
    slug: SUMMARY_SLUG,
    title: `Summary — #${channel.name}`,
    bodyMd: body,
    properties: {
      kind: 'channel-summary',
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
    body_md: body,
    message_count: included,
    model,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    generated_at: generatedAt,
  };
}
