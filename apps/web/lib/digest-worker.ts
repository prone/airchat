/**
 * Daily digest background worker (knowledge layer Phase 2).
 *
 * Modeled on gossip-sync.ts: a module-singleton setInterval worker, gated by
 * config, started from instrumentation.ts (with lazy fallback via the manual
 * trigger route /api/digest).
 *
 * Each pass: for every active local channel with enough messages on the
 * previous UTC day and no digest note yet, distill the day's messages into a
 * protected `daily-YYYY-MM-DD` note authored by the `summarizer` agent.
 * Also prunes old note revisions once per day.
 *
 * Enabled when AIRCHAT_DIGEST_ENABLED=true and ANTHROPIC_API_KEY is set.
 * The summarizer treats message content as untrusted data (design doc §10.5);
 * the prompt lives in @airchat/shared/digest so it is unit-tested.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  buildDigestUserPrompt,
  dayBounds,
  DIGEST_SYSTEM_PROMPT,
  digestSlug,
  formatMessagesForDigest,
  previousUtcDay,
  type DigestMessage,
} from '@airchat/shared';
import type { AgentContext } from '@airchat/shared';
import { getStorageAdapter, getSupabaseClient } from '@/lib/api-v2-auth';

const PASS_INTERVAL_MS = 30 * 60 * 1000; // check every 30 minutes
const MAX_MESSAGES_PER_DIGEST = 300;

/** Minimum messages in a channel-day before it earns a digest (AIRCHAT_DIGEST_MIN_MESSAGES). */
function minMessagesForDigest(): number {
  const parsed = parseInt(process.env.AIRCHAT_DIGEST_MIN_MESSAGES ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 5;
}
const SUMMARIZER_AGENT_NAME = 'summarizer';

let workerInterval: ReturnType<typeof setInterval> | null = null;
let passRunning = false;
let lastPruneDay: string | null = null;

function digestEnabled(): boolean {
  return process.env.AIRCHAT_DIGEST_ENABLED === 'true' && !!process.env.ANTHROPIC_API_KEY;
}

function digestModel(): string {
  return process.env.AIRCHAT_DIGEST_MODEL || 'claude-opus-4-8';
}

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

/** Find or create the summarizer agent — the only principal that writes digests. */
async function ensureSummarizerAgent(): Promise<AgentContext> {
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
      description: 'System summarizer — writes daily digest notes. Not machine-owned.',
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

async function generateDigestBody(
  channelId: string,
  channelName: string,
  date: string,
  messages: DigestMessage[],
): Promise<string> {
  const { transcript, included } = formatMessagesForDigest(messages);
  const response = await getAnthropic().messages.create({
    model: digestModel(),
    max_tokens: 4000, // digests are deliberately short (<300 words)
    thinking: { type: 'adaptive' },
    system: DIGEST_SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: buildDigestUserPrompt(channelName, date, transcript, included) },
    ],
  });

  // Ledger the spend regardless of outcome — refusals still bill streamed output
  await getSupabaseClient().from('llm_usage').insert({
    purpose: 'daily-digest',
    channel_id: channelId,
    model: digestModel(),
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    metadata: { date, note_slug: digestSlug(date), message_count: included, stop_reason: response.stop_reason },
  }).then(({ error }) => {
    if (error) console.error('[digest] failed to record llm_usage:', error.message);
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Digest generation refused by safety classifiers');
  }
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) throw new Error('Digest generation returned no text');
  return text;
}

export interface DigestPassResult {
  date: string;
  written: Array<{ channel: string; slug: string; message_count: number }>;
  skipped: Array<{ channel: string; reason: string }>;
  errors: Array<{ channel: string; error: string }>;
  pruned_revisions: number | null;
}

/** Run one digest pass. Exported for the manual trigger route. */
export async function runDigestPass(now: Date = new Date()): Promise<DigestPassResult> {
  const client = getSupabaseClient();
  const date = previousUtcDay(now);
  const { start, end } = dayBounds(date);
  const result: DigestPassResult = { date, written: [], skipped: [], errors: [], pruned_revisions: null };

  const summarizer = await ensureSummarizerAgent();
  const scoped = getStorageAdapter().forAgent(summarizer);

  // Digest local channels only — notes are local-only by design
  const { data: channels } = await client
    .from('channels')
    .select('id, name')
    .eq('federation_scope', 'local')
    .eq('archived', false);

  for (const ch of channels ?? []) {
    try {
      // Already digested?
      const { data: existingNote } = await client
        .from('notes')
        .select('id')
        .eq('channel_id', ch.id)
        .eq('slug', digestSlug(date))
        .single();
      if (existingNote) {
        result.skipped.push({ channel: ch.name, reason: 'already-digested' });
        continue;
      }

      const { data: msgs } = await client
        .from('messages')
        .select('content, created_at, agents:author_agent_id(name), author_display')
        .eq('channel_id', ch.id)
        .eq('quarantined', false)
        .gte('created_at', start)
        .lt('created_at', end)
        .order('created_at', { ascending: true })
        .limit(MAX_MESSAGES_PER_DIGEST);

      if (!msgs || msgs.length < minMessagesForDigest()) {
        result.skipped.push({ channel: ch.name, reason: `too-few-messages (${msgs?.length ?? 0})` });
        continue;
      }

      const digestMessages: DigestMessage[] = msgs.map((m: any) => ({
        author: m.agents?.name ?? m.author_display ?? 'unknown',
        content: m.content,
        created_at: m.created_at,
      }));

      const body = await generateDigestBody(ch.id, ch.name, date, digestMessages);

      await scoped.writeNote({
        channelName: ch.name,
        slug: digestSlug(date),
        title: `Daily digest — #${ch.name} — ${date}`,
        bodyMd: body,
        properties: {
          kind: 'daily-digest',
          date,
          message_count: msgs.length,
          model: digestModel(),
        },
        protect: true, // digests are trusted orientation; only the summarizer may edit
      });
      result.written.push({ channel: ch.name, slug: digestSlug(date), message_count: msgs.length });
    } catch (e) {
      result.errors.push({ channel: ch.name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Revision retention: prune once per UTC day
  const today = now.toISOString().slice(0, 10);
  if (lastPruneDay !== today) {
    const { data: pruned, error: pruneErr } = await client.rpc('prune_note_revisions');
    if (!pruneErr) {
      result.pruned_revisions = (pruned as number) ?? 0;
      lastPruneDay = today;
    }
  }

  return result;
}

async function digestLoop(): Promise<void> {
  if (passRunning || !digestEnabled()) return;
  passRunning = true;
  try {
    const result = await runDigestPass();
    if (result.written.length || result.errors.length) {
      console.log(
        `[digest] ${result.date}: wrote ${result.written.length} digest(s)` +
        (result.errors.length ? `, ${result.errors.length} error(s): ${JSON.stringify(result.errors)}` : ''),
      );
    }
  } catch (e) {
    console.error('[digest] pass failed:', e instanceof Error ? e.message : e);
  } finally {
    passRunning = false;
  }
}

/** Start the background worker (idempotent). No-op unless digest is enabled. */
export function startDigestWorker(): void {
  if (workerInterval || !digestEnabled()) return;
  console.log(`[digest] worker started (model: ${digestModel()}, every ${PASS_INTERVAL_MS / 60000}m)`);
  // First pass shortly after boot, then on the interval
  setTimeout(() => void digestLoop(), 15_000);
  workerInterval = setInterval(() => void digestLoop(), PASS_INTERVAL_MS);
}

export function stopDigestWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
}
