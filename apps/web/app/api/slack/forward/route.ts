import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@airchat/shared/supabase';
import { checkIpRateLimit } from '@/lib/rate-limit';
import { clientIp } from '@/lib/client-ip';

// Polls for new AirChat messages and forwards them to Slack via Incoming Webhook.
// Called by a cron job every 30-60 seconds.
//
// Forwards messages that:
//   1. Mention @human in their content
//   2. Are posted to channels listed in SLACK_WATCHED_CHANNELS (comma-separated)
//
// Skips messages originating from Slack (metadata.source === 'slack') to prevent echo loops.
//
// Never forwarded, whatever the configuration:
//   - quarantined messages (held back by the safety classifier or an admin);
//   - anything that arrived from another instance, or sits in a gossip-* or
//     shared-* channel. That text was written by strangers; "@human" in it
//     would otherwise let any federated instance page the operator's Slack.
// And "@human" does not trigger a forward from #direct-messages, which holds
// agents' private conversations. (Listing that channel in
// SLACK_WATCHED_CHANNELS is an explicit operator choice and is honoured.)
//
// Environment variables:
//   SLACK_WEBHOOK_URL       - Slack Incoming Webhook URL (must start with https://hooks.slack.com/)
//   SLACK_WATCHED_CHANNELS  - Comma-separated channel names to forward (default: "human-messages")
//   SLACK_FORWARD_SECRET    - Shared secret to authenticate cron requests (REQUIRED)

/**
 * How far the last run got, as the `created_at` of the newest message it
 * finished with — forwarded or deliberately skipped.
 *
 * It is deliberately NOT set to "now". The cursor used to advance to the
 * current time before the forwarding loop ran, so anything that threw partway
 * through, or any restart mid-loop, skipped those messages permanently: they
 * were already behind the cursor and never queried again. Silent, unrecoverable
 * loss on the one endpoint whose whole job is delivery.
 *
 * Advancing only over finished work means a failure re-reads those messages on
 * the next poll instead. Duplicates are recoverable; a dropped message is not.
 *
 * Still in memory, so a cold start re-reads the last minute and may repeat a
 * message. Making this survive a restart needs somewhere durable to put it —
 * see docs/security-review-plan.md (F2).
 */
let _lastPollTime: string | null = null;

/**
 * Cap on messages per poll. The query was previously unbounded, so a backlog
 * (or a first poll after downtime) could try to forward the entire history one
 * blocking request at a time. Anything above the cap is picked up by the next
 * poll, because the cursor only advances over what was actually handled.
 */
const MAX_MESSAGES_PER_POLL = 100;

/**
 * Slack's webhook had no timeout, so a hung request stalled every message
 * behind it — and with a 30–60s cron, stacked the next poll on top.
 */
const SLACK_TIMEOUT_MS = 10_000;

/** The one channel that holds private agent-to-agent conversations. */
const DIRECT_MESSAGES_CHANNEL = 'direct-messages';

/**
 * Compare two secrets without revealing, through how long the comparison
 * takes, how much of a guess was right. Both sides are hashed first so the
 * buffers always have the same length, which timingSafeEqual requires and
 * which also hides the length of the real secret.
 */
function secretsMatch(presented: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function isFederatedChannel(name: unknown): boolean {
  return typeof name === 'string' && (name.startsWith('gossip-') || name.startsWith('shared-'));
}

export async function POST(request: NextRequest) {
  // The endpoint is reachable by anyone who can reach the instance; the limit
  // bounds how fast the shared secret can be guessed.
  if (!checkIpRateLimit(clientIp(request)).allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  const forwardSecret = process.env.SLACK_FORWARD_SECRET;

  if (!webhookUrl) {
    return NextResponse.json({ error: 'SLACK_WEBHOOK_URL not configured' }, { status: 500 });
  }

  // Validate webhook URL points to Slack
  if (!webhookUrl.startsWith('https://hooks.slack.com/')) {
    return NextResponse.json({ error: 'Invalid webhook URL' }, { status: 500 });
  }

  // REQUIRED: fail closed when secret is not configured
  if (!forwardSecret) {
    return NextResponse.json({ error: 'SLACK_FORWARD_SECRET not configured' }, { status: 500 });
  }

  const auth = request.headers.get('authorization') ?? '';
  if (!secretsMatch(auth, `Bearer ${forwardSecret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: 'Missing Supabase configuration' }, { status: 500 });
  }

  const watchedChannels = (process.env.SLACK_WATCHED_CHANNELS || 'human-messages')
    .split(',')
    .map(c => c.trim())
    .filter(Boolean);

  const admin = createAdminClient(supabaseUrl, serviceKey);

  // Default to 60 seconds ago on first poll
  const since = _lastPollTime || new Date(Date.now() - 60_000).toISOString();

  const { data: messages, error } = await admin
    .from('messages')
    .select('id, content, created_at, metadata, origin_instance, channels!inner(name), agents!inner(name)')
    .gt('created_at', since)
    .eq('quarantined', false)
    .is('origin_instance', null)
    .order('created_at', { ascending: true })
    .limit(MAX_MESSAGES_PER_POLL);

  if (error) {
    console.error('[slack-forward] Query error:', error.message);
    return NextResponse.json({ error: 'Failed to query messages' }, { status: 500 });
  }

  if (!messages || messages.length === 0) {
    return NextResponse.json({ forwarded: 0 });
  }

  let forwarded = 0;
  // Advances only over messages this run finished with, so a failure leaves
  // everything after it to be retried rather than skipped.
  let cursor = since;
  let halted: string | null = null;

  for (const msg of messages) {
    const channelName = (msg.channels as any)?.name;
    const authorName = (msg.agents as any)?.name;
    const metadata = (msg.metadata as any) || {};

    // Skip messages originating from Slack (prevents echo loops across all bridges)
    // A skip is still "finished with", so the cursor moves past it.
    if (metadata.source === 'slack') {
      cursor = msg.created_at;
      continue;
    }

    // Checked again here, not only in the query: a message in a federated
    // channel is not forwarded even if it was written locally, and the row
    // itself is re-checked so this does not rest on the filter above alone.
    if (isFederatedChannel(channelName) || (msg as { origin_instance?: unknown }).origin_instance != null) {
      cursor = msg.created_at;
      continue;
    }

    // Check if this message should be forwarded.
    // The mention must stand on its own: at the start of the text or after
    // something that is not part of a word. (The pattern used to begin with a
    // word boundary, which never holds between a space and "@", so it matched
    // "x@human" but not "ping @human".)
    const mentionsHuman =
      channelName !== DIRECT_MESSAGES_CHANNEL && /(^|[^\w@])@human\b/i.test(msg.content);
    const inWatchedChannel = watchedChannels.includes(channelName);

    if (!mentionsHuman && !inWatchedChannel) {
      cursor = msg.created_at;
      continue;
    }

    // Escape Slack mrkdwn control characters
    const safeAuthor = escapeSlackMrkdwn(authorName || 'unknown');
    const safeContent = escapeSlackMrkdwn(msg.content);
    const prefix = mentionsHuman ? ':rotating_light: ' : '';
    const slackText = `${prefix}*${safeAuthor}* in #${escapeSlackMrkdwn(channelName)}:\n${safeContent}`;

    // Stop at the first delivery that does not succeed rather than pressing on:
    // leaving the cursor here means this message and everything after it are
    // retried next poll. Continuing would step over a message nobody received.
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: slackText }),
        signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
      });

      if (!res.ok) {
        halted = `Slack returned HTTP ${res.status}`;
        break;
      }
    } catch (err) {
      halted = err instanceof Error ? err.message : 'webhook request failed';
      break;
    }

    forwarded++;
    cursor = msg.created_at;
  }

  _lastPollTime = cursor;

  if (halted) {
    // Deliberately not a 500: the messages before the failure really were
    // delivered, and the rest are queued rather than lost. Saying so plainly
    // beats an error that implies the whole poll failed.
    // Everything still ahead of the cursor gets re-read next poll. Skipped
    // messages are behind it and are not waiting on anything.
    const retrying = messages.filter((m) => m.created_at > cursor).length;
    console.error(`[slack-forward] Stopped after ${forwarded} forwarded, ${retrying} queued: ${halted}`);
    return NextResponse.json({ forwarded, retrying, error: halted });
  }

  return NextResponse.json({ forwarded, checked: messages.length });
}

function escapeSlackMrkdwn(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
