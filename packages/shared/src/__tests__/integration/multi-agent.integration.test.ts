/**
 * Multi-agent integration tests for AirChat REST API.
 *
 * Tests two separate agents communicating: messages, @mentions,
 * DMs, and channel isolation.
 *
 * Run:
 *   npx vitest run packages/shared/src/__tests__/integration/multi-agent
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { AirChatRestClient } from '../../rest-client.js';

const UNIQUE_TAG = `multi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_CHANNEL = 'multi-agent-test';

let alice: AirChatRestClient;
let bob: AirChatRestClient;

beforeAll(() => {
  alice = AirChatRestClient.fromConfig({ agentName: 'macbook-test-alice' });
  bob = AirChatRestClient.fromConfig({ agentName: 'macbook-test-bob' });
});

// ── Both agents can register and reach the server ─────────────────────────

describe('agent registration', () => {
  it('alice can reach the board', async () => {
    const result = (await alice.checkBoard()) as any;
    expect(result._airchat).toBe('response');
  });

  it('bob can reach the board', async () => {
    const result = (await bob.checkBoard()) as any;
    expect(result._airchat).toBe('response');
  });
});

// ── Cross-agent messaging ─────────────────────────────────────────────────

describe('cross-agent messaging', () => {
  const aliceMessage = `Alice says hello [${UNIQUE_TAG}]`;
  const bobMessage = `Bob replies [${UNIQUE_TAG}]`;

  it('alice sends a message', async () => {
    const result = (await alice.sendMessage(TEST_CHANNEL, aliceMessage)) as any;
    expect(result.data.message.content).toBe(aliceMessage);
  });

  it('bob can read alice\'s message', async () => {
    const result = (await bob.readMessages(TEST_CHANNEL, 10)) as any;
    const found = result.data.messages.find((m: any) => m.content === aliceMessage);
    expect(found).toBeDefined();
  });

  it('bob sends a reply in the same channel', async () => {
    const result = (await bob.sendMessage(TEST_CHANNEL, bobMessage)) as any;
    expect(result.data.message.content).toBe(bobMessage);
  });

  it('alice can read bob\'s message', async () => {
    const result = (await alice.readMessages(TEST_CHANNEL, 10)) as any;
    const found = result.data.messages.find((m: any) => m.content === bobMessage);
    expect(found).toBeDefined();
  });

  it('both messages appear in channel for both agents', async () => {
    const result = (await alice.readMessages(TEST_CHANNEL, 20)) as any;
    const messages = result.data.messages.map((m: any) => m.content);
    expect(messages).toContain(aliceMessage);
    expect(messages).toContain(bobMessage);
  });
});

// ── Thread replies across agents ──────────────────────────────────────────

describe('cross-agent threads', () => {
  let parentId: string;

  it('alice starts a thread', async () => {
    const result = (await alice.sendMessage(
      TEST_CHANNEL,
      `Thread starter from Alice [${UNIQUE_TAG}]`,
    )) as any;
    parentId = result.data.message.id;
    expect(parentId).toBeDefined();
  });

  it('bob replies to alice\'s thread', async () => {
    const result = (await bob.sendMessage(
      TEST_CHANNEL,
      `Bob\'s thread reply [${UNIQUE_TAG}]`,
      parentId,
    )) as any;
    expect(result.data.message.parent_message_id).toBe(parentId);
  });
});

// ── @Mentions across agents ───────────────────────────────────────────────

describe('cross-agent mentions', () => {
  it('alice mentions bob in a message', async () => {
    const bobName = bob.getAgentName();
    const result = (await alice.sendMessage(
      TEST_CHANNEL,
      `Hey @${bobName} check this out [${UNIQUE_TAG}]`,
    )) as any;
    expect(result.data.message.content).toContain(`@${bobName}`);
  });

  it('bob sees the mention in his unread mentions', async () => {
    // Small delay for the DB trigger to process
    await new Promise((r) => setTimeout(r, 500));

    const result = (await bob.checkMentions(true)) as any;
    expect(result._airchat).toBe('response');
    expect(result.data.mentions).toBeInstanceOf(Array);

    const mention = result.data.mentions.find((m: any) =>
      m.content?.includes(UNIQUE_TAG) || m.message_content?.includes(UNIQUE_TAG),
    );
    expect(mention).toBeDefined();
  });

  it('bob marks the mention as read', async () => {
    const mentions = (await bob.checkMentions(true)) as any;
    const ids = mentions.data.mentions
      .filter((m: any) =>
        (m.content?.includes(UNIQUE_TAG) || m.message_content?.includes(UNIQUE_TAG)),
      )
      .map((m: any) => m.id || m.mention_id);

    if (ids.length > 0) {
      const result = (await bob.markMentionsRead(ids)) as any;
      expect(result._airchat).toBe('response');
    }
  });

  it('mention no longer appears in bob\'s unread', async () => {
    const result = (await bob.checkMentions(true)) as any;
    const mention = result.data.mentions.find((m: any) =>
      m.content?.includes(UNIQUE_TAG) || m.message_content?.includes(UNIQUE_TAG),
    );
    expect(mention).toBeUndefined();
  });

  it('alice mentions bob do not appear in alice\'s mentions', async () => {
    const result = (await alice.checkMentions(false)) as any;
    // Alice should not have mentions for messages she sent
    const selfMention = result.data.mentions.find((m: any) =>
      (m.content?.includes(UNIQUE_TAG) || m.message_content?.includes(UNIQUE_TAG)) &&
      (m.mentioning_agent === alice.getAgentName()),
    );
    // Self-mentions are blocked by the DB trigger
    expect(selfMention).toBeUndefined();
  });
});

// ── Direct messages between agents ────────────────────────────────────────

describe('cross-agent DMs', () => {
  it('alice sends bob a DM', async () => {
    const result = (await alice.sendDirectMessage(
      bob.getAgentName(),
      `Private message from Alice [${UNIQUE_TAG}]`,
    )) as any;
    expect(result._airchat).toBe('response');
    expect(result.data.message).toBeDefined();
  });

  it('bob sends alice a DM', async () => {
    const result = (await bob.sendDirectMessage(
      alice.getAgentName(),
      `Private reply from Bob [${UNIQUE_TAG}]`,
    )) as any;
    expect(result._airchat).toBe('response');
    expect(result.data.message).toBeDefined();
  });
});

// ── Search visibility across agents ───────────────────────────────────────

describe('cross-agent search', () => {
  it('bob can search and find alice\'s messages', async () => {
    await new Promise((r) => setTimeout(r, 1000));

    const result = (await bob.searchMessages(UNIQUE_TAG)) as any;
    expect(result.data.results.length).toBeGreaterThanOrEqual(1);

    // Should find messages from alice
    const aliceMsg = result.data.results.find((r: any) =>
      r.content?.includes('Alice says hello'),
    );
    expect(aliceMsg).toBeDefined();
  });

  it('alice can search and find bob\'s messages', async () => {
    const result = (await alice.searchMessages(UNIQUE_TAG)) as any;
    const bobMsg = result.data.results.find((r: any) =>
      r.content?.includes('Bob replies'),
    );
    expect(bobMsg).toBeDefined();
  });
});

// ── Board shows activity from both agents ─────────────────────────────────

describe('board reflects multi-agent activity', () => {
  it('board shows the test channel for alice', async () => {
    const result = (await alice.checkBoard()) as any;
    const channels = result.data.channels.map((c: any) => c.channel);
    expect(channels).toContain(TEST_CHANNEL);
  });

  it('board shows the test channel for bob', async () => {
    const result = (await bob.checkBoard()) as any;
    const channels = result.data.channels.map((c: any) => c.channel);
    expect(channels).toContain(TEST_CHANNEL);
  });
});

// ── Channel membership ────────────────────────────────────────────────────

describe('channel membership', () => {
  it('both agents appear in the test channel member list', async () => {
    const aliceChannels = (await alice.listChannels()) as any;
    const bobChannels = (await bob.listChannels()) as any;

    const aliceInChannel = aliceChannels.data.channels.some(
      (c: any) => (c.name ?? c.channel) === TEST_CHANNEL,
    );
    const bobInChannel = bobChannels.data.channels.some(
      (c: any) => (c.name ?? c.channel) === TEST_CHANNEL,
    );

    expect(aliceInChannel).toBe(true);
    expect(bobInChannel).toBe(true);
  });
});
