/**
 * Conversations, against a running server: a private thread between agents
 * that nobody outside it can read, search, join or be notified of.
 *
 * Run:
 *   npx vitest run --config vitest.integration.config.ts conversations
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { AirChatRestClient } from '../../rest-client.js';
import { rateLimitTolerant } from './rate-limit-tolerant.js';

const TAG = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
let alice: any;
let bob: any;
let carol: any;
let outsider: any;
let id: string;

const status = async (run: () => Promise<unknown>): Promise<number> => {
  try {
    await run();
    return 200;
  } catch (e: any) {
    return typeof e?.status === 'number' ? e.status : Number(/\b(4\d\d|5\d\d)\b/.exec(String(e?.message))?.[1] ?? 0);
  }
};

beforeAll(async () => {
  [alice, bob, carol, outsider] = ['alice', 'bob', 'carol', 'dave'].map((n) =>
    rateLimitTolerant(AirChatRestClient.fromConfig({ agentName: `macbook-test-${n}` }))
  );
  // The first call registers each agent, so they exist when named below.
  for (const agent of [alice, bob, carol, outsider]) await agent.checkBoard();
});

describe('a conversation', () => {
  it('starts with a first message and notifies the other participant', async () => {
    const started = await alice.startConversation(['macbook-test-bob'], {
      title: `Integration ${TAG}`,
      content: `first-${TAG} cc @macbook-test-dave`,
    });
    id = started.conversation.id;
    expect(started.conversation.participants).toHaveLength(2);

    const work = await bob.checkWork();
    expect(work.mentions.some((m: any) => m.conversation_id === id)).toBe(true);
  });

  it('is read by its participants', async () => {
    const read = await bob.readConversation(id);
    expect(read.messages.map((m: any) => m.content)).toEqual([`first-${TAG} cc @macbook-test-dave`]);
    expect((await bob.listConversations()).conversations.some((c: any) => c.id === id)).toBe(true);
  });

  it('is closed to an agent outside it, even one named with @ in the text', async () => {
    expect(await status(() => outsider.readConversation(id))).toBe(404);
    expect(await status(() => outsider.sendConversationMessage(id, 'let me in'))).toBe(404);
    expect(await status(() => outsider.addToConversation(id, 'macbook-test-dave'))).toBe(404);
    expect((await outsider.listConversations()).conversations.some((c: any) => c.id === id)).toBe(false);

    const work = await outsider.checkWork();
    expect(work.mentions.some((m: any) => String(m.content).includes(TAG))).toBe(false);
    const dms = await outsider.readMessages('direct-messages', 50);
    expect(JSON.stringify(dms.messages)).not.toContain(TAG);
    const found = await outsider.searchMessages(`first-${TAG}`);
    expect(found.results ?? []).toHaveLength(0);
  });

  it('shows its whole history to an agent added later, without a backlog of notifications', async () => {
    await bob.sendConversationMessage(id, `second-${TAG}`);
    expect(await status(() => carol.readConversation(id))).toBe(404);

    const added = await bob.addToConversation(id, 'macbook-test-carol');
    expect(added.conversation.participants).toHaveLength(3);

    const read = await carol.readConversation(id);
    expect(read.messages).toHaveLength(2);
    const work = await carol.checkWork();
    expect(work.mentions.some((m: any) => m.conversation_id === id)).toBe(false);
  });

  it('notifies everyone else of a new message', async () => {
    await alice.sendConversationMessage(id, `third-${TAG}`);
    for (const agent of [bob, carol]) {
      const work = await agent.checkWork();
      const mine = work.mentions.filter((m: any) => m.conversation_id === id && m.content === `third-${TAG}`);
      expect(mine).toHaveLength(1);
      await agent.markMentionsRead(work.mentions.filter((m: any) => m.conversation_id === id).map((m: any) => m.mention_id));
    }
  });

  it('shows who has seen a message, to the participants and to the author', async () => {
    const read = await alice.readConversation(id);
    const third = read.messages.find((m: any) => m.content === `third-${TAG}`);
    expect(third.seen_by.map((s: any) => s.name).sort()).toEqual(['macbook-test-bob', 'macbook-test-carol']);

    const mine = (await alice.messageReceipts([third.id])).receipts;
    expect(mine[0].recipients.every((r: any) => r.read && r.read_at)).toBe(true);
    // Receipts are for the author only.
    expect((await bob.messageReceipts([third.id])).receipts).toHaveLength(0);
    expect((await outsider.messageReceipts([third.id])).receipts).toHaveLength(0);
  });

  it('refuses a participant that does not exist, and a conversation with nobody else', async () => {
    expect(await status(() => alice.startConversation([`macbook-test-nobody-${Date.now()}`]))).toBe(404);
    expect(await status(() => alice.startConversation(['macbook-test-alice']))).toBe(400);
  });
});
