/**
 * One pass of the AirChat → Slack forwarder.
 *
 * Kept apart from index.ts (which starts the Slack app on import) so it can be
 * tested, and because its one rule is easy to get wrong:
 *
 *   a channel's cursor moves only past messages that were actually delivered.
 *
 * The forwarder used to keep a single "last poll time" for all channels and
 * advance it only when a whole pass succeeded. After a failure it re-read the
 * window, which was the point — but a pass that had already posted channel A
 * to Slack before failing on channel B posted A's messages again on recovery,
 * and again on each further partial failure.
 */

export interface ForwardableMessage {
  content: string;
  timestamp?: string;
  created_at?: string;
  author?: string;
  agents?: { name?: string } | null;
  project?: string;
  metadata?: { source?: string } | null;
}

export interface ForwardDeps {
  readMessages(channel: string, limit: number): Promise<{ messages?: ForwardableMessage[] } | null | undefined>;
  postToSlack(text: string): Promise<void>;
}

export function escapeSlackMrkdwn(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const at = (m: ForwardableMessage): string => m.timestamp || m.created_at || '';

/**
 * Forward every message newer than each channel's cursor, oldest first,
 * advancing that channel's cursor after each successful post. Throws on the
 * first failure; everything delivered before it stays delivered and is not
 * sent again.
 */
export async function forwardNewMessages(
  channels: string[],
  cursors: Map<string, string>,
  startedAt: string,
  deps: ForwardDeps,
): Promise<number> {
  let forwarded = 0;
  for (const channel of channels) {
    const result = await deps.readMessages(channel, 50);
    const since = cursors.get(channel) ?? startedAt;
    const fresh = (result?.messages ?? [])
      .filter((m) => at(m) && at(m) > since)
      .sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0));

    for (const msg of fresh) {
      // Skip messages that came from Slack in the first place (echo prevention).
      // Still advance past them: there is nothing to deliver.
      if (msg.project !== 'slack' && msg.metadata?.source !== 'slack') {
        const author = msg.author || msg.agents?.name || 'unknown';
        // Not /\b@human/: there is no word boundary before "@" at the start of a
        // message or after a space, so that never matched where it mattered.
        const prefix = /(^|[^\w@])@human\b/i.test(msg.content) ? ':rotating_light: ' : '';
        await deps.postToSlack(
          `${prefix}*${escapeSlackMrkdwn(author)}* in #${escapeSlackMrkdwn(channel)}:\n${escapeSlackMrkdwn(msg.content)}`,
        );
        forwarded++;
      }
      cursors.set(channel, at(msg));
    }
  }
  return forwarded;
}
