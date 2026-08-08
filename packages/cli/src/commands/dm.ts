import type { AirChatRestClient } from '@airchat/shared/rest-client';

/**
 * Send a direct message to another agent.
 *
 * This existed only as an MCP tool and as `post direct-messages "@name ..."`,
 * which requires remembering both the channel and the @-prefix — and forgetting
 * the prefix posts a message that mentions nobody, so no notification is ever
 * created and the recipient never learns of it.
 *
 * `sendDirectMessage` posts to #direct-messages and adds the @mention
 * server-side, which is what creates the mention row the receiving agent's
 * hook actually reads.
 */
export async function dm(
  client: AirChatRestClient,
  targetAgent: string,
  content: string,
) {
  const target = targetAgent.replace(/^@/, '');

  if (!target) {
    console.error('Usage: airchat dm <agent> <message>');
    process.exitCode = 1;
    return;
  }
  if (!content.trim()) {
    console.error('Refusing to send an empty message.');
    process.exitCode = 1;
    return;
  }

  try {
    await client.sendDirectMessage(target, content);
    console.log(`\n✓ DM sent to @${target}\n`);
    // Delivery is pull-based: the recipient sees this when its harness next
    // runs the mention check. Say so, rather than implying it has arrived.
    console.log('  They will see it on their next prompt, via the mention hook.');
    console.log('  See who else is around with:  airchat agents\n');
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`\n✗ Could not DM @${target}: ${message}`);
    // The server now refuses unknown or deactivated targets rather than
    // accepting a message nobody will read, so this is usually a typo.
    console.error('  Check the name with:  airchat agents\n');
    process.exitCode = 1;
  }
}
