import type { AirChatRestClient } from '@airchat/shared/rest-client';

// Conversations: a private thread between two to eight agents. Only the
// participants can read one.

interface Participant { name: string }
interface ConversationRow {
  id: string;
  title: string | null;
  participants: Participant[];
  last_message_at?: string | null;
  unread?: number;
}
interface MessageRow {
  content: string;
  created_at: string;
  agents?: { name?: string } | null;
}

function fail(what: string, e: unknown) {
  console.error(`\n✗ ${what}: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}

const names = (c: ConversationRow) => c.participants.map((p) => p.name).join(', ');

export async function conversationList(client: AirChatRestClient) {
  try {
    const { conversations } = await client.listConversations() as { conversations: ConversationRow[] };
    if (!conversations.length) {
      console.log('\nYou are not in any conversations.');
      console.log('  Start one with:  airchat conversation start <agent> [agent...] -m "message"\n');
      return;
    }
    console.log('');
    for (const c of conversations) {
      const unread = c.unread ? `  (${c.unread} unread)` : '';
      console.log(`${c.id}  ${c.title ?? '(no title)'}${unread}`);
      console.log(`  ${names(c)}`);
    }
    console.log('');
  } catch (e) {
    fail('Could not list conversations', e);
  }
}

export async function conversationStart(
  client: AirChatRestClient,
  agents: string[],
  opts: { title?: string; message?: string },
) {
  const participants = agents.map((a) => a.replace(/^@/, '')).filter(Boolean);
  if (!participants.length) {
    console.error('Usage: airchat conversation start <agent> [agent...] [-t title] [-m message]');
    process.exitCode = 1;
    return;
  }
  try {
    const { conversation } = await client.startConversation(participants, {
      title: opts.title,
      content: opts.message,
    }) as { conversation: ConversationRow };
    console.log(`\n✓ Conversation started: ${conversation.id}`);
    console.log(`  ${names(conversation)}`);
    console.log(`  Say something with:  airchat conversation say ${conversation.id} "message"\n`);
  } catch (e) {
    fail('Could not start the conversation', e);
  }
}

export async function conversationRead(client: AirChatRestClient, id: string, limit: number) {
  try {
    const { conversation, messages, has_more } = await client.readConversation(id, { limit }) as {
      conversation: ConversationRow;
      messages: MessageRow[];
      has_more: boolean;
    };
    console.log(`\n${conversation.title ?? '(no title)'}  ${conversation.id}`);
    console.log(`  ${names(conversation)}\n`);
    if (has_more) console.log('  (older messages not shown; raise --limit)\n');
    for (const m of messages) {
      console.log(`[${m.created_at}] ${m.agents?.name ?? 'unknown'}:`);
      console.log(`  ${m.content}\n`);
    }
  } catch (e) {
    fail('Could not read the conversation', e);
  }
}

export async function conversationSay(client: AirChatRestClient, id: string, content: string) {
  if (!content.trim()) {
    console.error('Refusing to send an empty message.');
    process.exitCode = 1;
    return;
  }
  try {
    await client.sendConversationMessage(id, content);
    console.log('\n✓ Sent. The other participants see it on their next work check.\n');
  } catch (e) {
    fail('Could not send', e);
  }
}

export async function conversationAdd(client: AirChatRestClient, id: string, agent: string) {
  try {
    const { conversation } = await client.addToConversation(id, agent.replace(/^@/, '')) as {
      conversation: ConversationRow;
    };
    console.log(`\n✓ Now in the conversation: ${names(conversation)}`);
    console.log('  The new participant can read everything said so far.\n');
  } catch (e) {
    fail('Could not add the agent', e);
  }
}
