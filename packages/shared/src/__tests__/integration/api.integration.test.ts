/**
 * Integration tests for AirChat REST API.
 *
 * These tests hit the real running server and exercise end-to-end flows:
 *   register → send → read → search → mentions → board → channels
 *   threads → channel filtering → gossip → file upload/download → @mentions
 *
 * Requires:
 *   - AirChat server running (AIRCHAT_WEB_URL in ~/.airchat/config)
 *   - Valid machine key at ~/.airchat/machine.key
 *
 * Run:
 *   npx vitest run packages/shared/src/__tests__/integration/
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { AirChatRestClient } from '../../rest-client.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Use a dedicated test channel to avoid polluting real channels
const TEST_CHANNEL = 'integration-test';
const UNIQUE_TAG = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let client: AirChatRestClient;

// Helper: raw fetch with the agent's derived key
async function rawFetch(
  method: string,
  pathname: string,
  body?: unknown,
  params?: URLSearchParams,
): Promise<Response> {
  const keyPath = path.join(os.homedir(), '.airchat', 'agents', 'macbook-integration-test.key');
  const apiKey = fs.readFileSync(keyPath, 'utf-8').trim();
  const configText = fs.readFileSync(path.join(os.homedir(), '.airchat', 'config'), 'utf-8');
  const webUrl = configText.match(/AIRCHAT_WEB_URL=(.+)/)?.[1]?.trim() ?? '';

  let url = `${webUrl}${pathname}`;
  if (params?.toString()) url += `?${params}`;

  const headers: Record<string, string> = { 'x-agent-api-key': apiKey };
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(15000) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return fetch(url, init);
}

beforeAll(() => {
  client = AirChatRestClient.fromConfig({
    agentName: 'macbook-integration-test',
  });
});

// ── Health: can we reach the server? ──────────────────────────────────────

describe('server connectivity', () => {
  it('board endpoint responds', async () => {
    const result = (await client.checkBoard()) as any;
    expect(result).toBeDefined();
    expect(result._airchat).toBe('response');
    expect(result.data).toBeDefined();
    expect(result.data.channels).toBeInstanceOf(Array);
  });
});

// ── Messages: send → read round-trip ──────────────────────────────────────

describe('messages', () => {
  const content = `Integration test message [${UNIQUE_TAG}]`;

  it('sends a message', async () => {
    const result = (await client.sendMessage(TEST_CHANNEL, content)) as any;
    expect(result._airchat).toBe('response');
    expect(result.data).toBeDefined();
    expect(result.data.message).toBeDefined();
    expect(result.data.message.content).toBe(content);
  });

  it('reads the message back', async () => {
    const result = (await client.readMessages(TEST_CHANNEL, 10)) as any;
    expect(result._airchat).toBe('response');
    expect(result.data.messages).toBeInstanceOf(Array);

    const found = result.data.messages.find(
      (m: any) => m.content === content,
    );
    expect(found).toBeDefined();
    expect(found.content).toBe(content);
  });

  it('sends a message with metadata', async () => {
    const metadata = { test: true, tag: UNIQUE_TAG };
    const result = (await client.sendMessage(
      TEST_CHANNEL,
      `Metadata test [${UNIQUE_TAG}]`,
      undefined,
      metadata,
    )) as any;
    expect(result._airchat).toBe('response');
    expect(result.data.message.metadata).toMatchObject(metadata);
  });

  it('respects limit parameter', async () => {
    const result = (await client.readMessages(TEST_CHANNEL, 1)) as any;
    expect(result.data.messages).toHaveLength(1);
  });
});

// ── Thread replies ────────────────────────────────────────────────────────

describe('thread replies', () => {
  let parentId: string;

  it('sends a parent message', async () => {
    const result = (await client.sendMessage(
      TEST_CHANNEL,
      `Thread parent [${UNIQUE_TAG}]`,
    )) as any;
    parentId = result.data.message.id;
    expect(parentId).toBeDefined();
  });

  it('sends a reply to the parent', async () => {
    const result = (await client.sendMessage(
      TEST_CHANNEL,
      `Thread reply [${UNIQUE_TAG}]`,
      parentId,
    )) as any;
    expect(result._airchat).toBe('response');
    expect(result.data.message.parent_message_id).toBe(parentId);
  });

  it('rejects invalid parent_message_id format', async () => {
    await expect(
      client.sendMessage(TEST_CHANNEL, 'bad parent', 'not-a-uuid'),
    ).rejects.toThrow(/400/);
  });
});

// ── Channels: listing and filtering ───────────────────────────────────────

describe('channels', () => {
  it('lists channels including the test channel', async () => {
    const result = (await client.listChannels()) as any;
    expect(result._airchat).toBe('response');
    expect(result.data.channels).toBeInstanceOf(Array);

    const names = result.data.channels.map((c: any) => c.name ?? c.channel);
    expect(names).toContain(TEST_CHANNEL);
  });

  it('filters channels by type', async () => {
    // Should not throw even if no channels match
    const result = (await client.listChannels('global')) as any;
    expect(result._airchat).toBe('response');
    expect(result.data.channels).toBeInstanceOf(Array);
  });

  it('rejects invalid channel type filter', async () => {
    const res = await rawFetch(
      'GET',
      '/api/v2/channels',
      undefined,
      new URLSearchParams({ type: 'bogus' }),
    );
    expect(res.status).toBe(400);
  });
});

// ── Board: overview with unread counts ────────────────────────────────────

describe('board', () => {
  it('returns board overview with channel data', async () => {
    const result = (await client.checkBoard()) as any;
    expect(result._airchat).toBe('response');
    expect(result.data.channels).toBeInstanceOf(Array);
    expect(result.data.channels.length).toBeGreaterThan(0);

    const ch = result.data.channels[0];
    expect(ch).toHaveProperty('channel');
  });
});

// ── Search: find the message we sent ──────────────────────────────────────

describe('search', () => {
  it('finds the test message by unique tag', async () => {
    await new Promise((r) => setTimeout(r, 1000));

    const result = (await client.searchMessages(UNIQUE_TAG)) as any;
    expect(result._airchat).toBe('response');
    expect(result.data.results).toBeInstanceOf(Array);
    expect(result.data.results.length).toBeGreaterThanOrEqual(1);

    const match = result.data.results.find((r: any) =>
      r.content?.includes(UNIQUE_TAG),
    );
    expect(match).toBeDefined();
  });

  it('scopes search to a channel', async () => {
    const result = (await client.searchMessages(
      UNIQUE_TAG,
      TEST_CHANNEL,
    )) as any;
    expect(result.data.results.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty for nonsense query', async () => {
    const result = (await client.searchMessages(
      'zzzznotarealquery999999',
    )) as any;
    expect(result.data.results).toHaveLength(0);
  });
});

// ── @Mentions: trigger via message content ────────────────────────────────

describe('mentions', () => {
  it('checks mentions without error', async () => {
    const result = (await client.checkMentions(false)) as any;
    expect(result._airchat).toBe('response');
    expect(result.data.mentions).toBeInstanceOf(Array);
  });

  it('creates a mention via @agent in message content', async () => {
    // Send a message mentioning our own agent name
    const agentName = client.getAgentName();
    await client.sendMessage(
      TEST_CHANNEL,
      `Hey @${agentName} mention test [${UNIQUE_TAG}]`,
    );

    // Self-mentions are blocked by the DB trigger, so we won't find one.
    // But verify the endpoint still works.
    const result = (await client.checkMentions(true)) as any;
    expect(result._airchat).toBe('response');
    expect(result.data.mentions).toBeInstanceOf(Array);
  });

  it('mark mentions read with empty array returns 400', async () => {
    // Server requires at least one mention ID
    await expect(client.markMentionsRead([])).rejects.toThrow(/400/);
  });

  it('rejects invalid mention IDs', async () => {
    const res = await rawFetch('POST', '/api/v2/mentions', {
      mention_ids: ['not-a-uuid'],
    });
    expect(res.status).toBe(400);
  });
});

// ── Direct messages ───────────────────────────────────────────────────────

describe('direct messages', () => {
  it('sends a DM to self', async () => {
    const result = (await client.sendDirectMessage(
      client.getAgentName(),
      `DM self-test [${UNIQUE_TAG}]`,
    )) as any;
    expect(result._airchat).toBe('response');
    expect(result.data.message).toBeDefined();
  });
});

// ── File upload and download ──────────────────────────────────────────────

describe('file operations', () => {
  const testFileName = `test-${UNIQUE_TAG}.txt`;
  const testContent = `Hello from integration test ${UNIQUE_TAG}`;
  let uploadedPath: string;
  let storageAvailable = false;

  it('uploads a text file via PUT /api/files', async () => {
    const res = await rawFetch('PUT', '/api/files', {
      filename: testFileName,
      content: testContent,
      channel: TEST_CHANNEL,
      content_type: 'text/plain',
      encoding: 'utf-8',
      post_message: false,
    });
    if (res.status === 500) {
      const body = await res.json();
      if (body.error === 'Upload failed') {
        console.warn('SKIP: Storage bucket not configured on server (expected in dev)');
        return;
      }
    }
    expect(res.status).toBe(200);
    storageAvailable = true;
    const body = await res.json();
    expect(body.file).toBeDefined();
    expect(body.file.name).toBe(testFileName);
    expect(body.file.size).toBe(Buffer.byteLength(testContent, 'utf-8'));
    uploadedPath = body.file.path;
    expect(uploadedPath).toContain(TEST_CHANNEL);
  });

  it('downloads the file by path', async () => {
    if (!storageAvailable) {
      console.warn('SKIP: Storage not available');
      return;
    }
    const res = await rawFetch(
      'GET',
      '/api/files',
      undefined,
      new URLSearchParams({ path: uploadedPath }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe(testContent);
  });

  it('gets a signed URL for the file', async () => {
    if (!storageAvailable) {
      console.warn('SKIP: Storage not available');
      return;
    }
    const res = await rawFetch(
      'GET',
      '/api/files',
      undefined,
      new URLSearchParams({ path: uploadedPath, url: 'true' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.signed_url).toBeDefined();
    expect(body.expires_in).toBe(3600);
  });

  it('uploads a base64-encoded file', async () => {
    if (!storageAvailable) {
      console.warn('SKIP: Storage not available');
      return;
    }
    const b64Content = Buffer.from('binary test data').toString('base64');
    const res = await rawFetch('PUT', '/api/files', {
      filename: `b64-${UNIQUE_TAG}.bin`,
      content: b64Content,
      channel: TEST_CHANNEL,
      encoding: 'base64',
      post_message: false,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.file.size).toBe(16);
  });

  it('rejects path traversal in download', async () => {
    const res = await rawFetch(
      'GET',
      '/api/files',
      undefined,
      new URLSearchParams({ path: '../../../etc/passwd' }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects upload with invalid channel name', async () => {
    const res = await rawFetch('PUT', '/api/files', {
      filename: 'test.txt',
      content: 'hello',
      channel: 'INVALID!!!',
    });
    expect(res.status).toBe(400);
  });

  it('rejects upload missing required fields', async () => {
    const res = await rawFetch('PUT', '/api/files', {
      filename: 'test.txt',
    });
    expect(res.status).toBe(400);
  });

  it('lists files in the test channel folder', async () => {
    if (!storageAvailable) {
      console.warn('SKIP: Storage not available');
      return;
    }
    const res = await rawFetch('POST', '/api/files', {
      folder: TEST_CHANNEL,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files).toBeInstanceOf(Array);
    expect(body.files.length).toBeGreaterThan(0);
  });
});

// ── Gossip management ─────────────────────────────────────────────────────

describe('gossip', () => {
  it('gets gossip status', async () => {
    const result = (await client.gossipStatus()) as any;
    expect(result._airchat).toBe('response');
    expect(result.data).toBeDefined();
    expect(result.data).toHaveProperty('instance');
    expect(result.data).toHaveProperty('peers');
    expect(result.data.peers).toHaveProperty('total');
    expect(result.data.peers).toHaveProperty('active');
    expect(result.data.peers).toHaveProperty('supernodes');
    expect(result.data).toHaveProperty('health');
  });

  it('lists peers', async () => {
    const result = (await client.listPeers()) as any;
    expect(result._airchat).toBe('response');
    expect(result.data.peers).toBeInstanceOf(Array);
  });

  it('rejects invalid gossip action', async () => {
    const res = await rawFetch('POST', '/api/v2/gossip', { action: 'explode' });
    expect(res.status).toBe(400);
  });

  it('rejects adding peer with invalid fingerprint', async () => {
    const res = await rawFetch('POST', '/api/v2/gossip/peers', {
      endpoint: 'https://fake-peer.example.com',
      fingerprint: 'abc', // too short, must be >= 8 hex chars
    });
    // Should fail validation or connectivity check
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ── Federated channel limits ──────────────────────────────────────────────

describe('federated channel limits', () => {
  it('accepts messages within gossip limit (500 chars)', async () => {
    const content = 'y'.repeat(499);
    // May hit gossip rate limit, so we accept either success or 429
    try {
      const result = (await client.sendMessage('gossip-test', content)) as any;
      expect(result._airchat).toBe('response');
    } catch (e: any) {
      expect(e.message).toMatch(/429/);
    }
  });

  it('rejects messages over gossip limit', async () => {
    const oversized = 'x'.repeat(600);
    await expect(
      client.sendMessage('gossip-test', oversized),
    ).rejects.toThrow(/4[02][09]/);
  });

  it('accepts messages within shared limit (2000 chars)', async () => {
    const content = `shared-test-${UNIQUE_TAG}-${'z'.repeat(1900)}`;
    try {
      const result = (await client.sendMessage('shared-test', content)) as any;
      expect(result._airchat).toBe('response');
    } catch (e: any) {
      // May hit gossip_write rate limit
      expect(e.message).toMatch(/429/);
    }
  });

  it('rejects messages over shared limit', async () => {
    const oversized = 'x'.repeat(2100);
    await expect(
      client.sendMessage('shared-test', oversized),
    ).rejects.toThrow(/4[02][09]/);
  });

  it('accepts long messages on local channels (up to 32000)', async () => {
    const content = `local-long-${UNIQUE_TAG}-${'a'.repeat(5000)}`;
    const result = (await client.sendMessage(TEST_CHANNEL, content)) as any;
    expect(result._airchat).toBe('response');
    expect(result.data.message.content).toBe(content);
  });

  it('rejects messages over local limit (32000)', async () => {
    const oversized = 'x'.repeat(33000);
    await expect(
      client.sendMessage(TEST_CHANNEL, oversized),
    ).rejects.toThrow(/400/);
  });

  it('rejects oversized metadata on federated channels', async () => {
    // Federated metadata limit is 1024 bytes
    const bigMetadata: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      bigMetadata[`key_${i}`] = 'x'.repeat(30);
    }
    // This creates ~1500+ bytes of JSON metadata
    try {
      await client.sendMessage('shared-test', 'metadata test', undefined, bigMetadata);
      // If it succeeded, the limit isn't enforced — mark as unexpected
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toMatch(/4[02][09]/);
    }
  });
});

// ── Authentication ────────────────────────────────────────────────────────

describe('authentication', () => {
  it('rejects requests with no API key', async () => {
    const configText = fs.readFileSync(path.join(os.homedir(), '.airchat', 'config'), 'utf-8');
    const webUrl = configText.match(/AIRCHAT_WEB_URL=(.+)/)?.[1]?.trim() ?? '';

    const res = await fetch(`${webUrl}/api/v2/board`, {
      signal: AbortSignal.timeout(10000),
    });
    expect(res.status).toBe(401);
  });

  it('rejects requests with invalid API key', async () => {
    const configText = fs.readFileSync(path.join(os.homedir(), '.airchat', 'config'), 'utf-8');
    const webUrl = configText.match(/AIRCHAT_WEB_URL=(.+)/)?.[1]?.trim() ?? '';

    const res = await fetch(`${webUrl}/api/v2/board`, {
      headers: { 'x-agent-api-key': 'totally-fake-key-1234567890abcdef' },
      signal: AbortSignal.timeout(10000),
    });
    expect(res.status).toBe(401);
  });
});

// ── Error handling ────────────────────────────────────────────────────────

describe('error handling', () => {
  it('rejects empty message content', async () => {
    await expect(
      client.sendMessage(TEST_CHANNEL, ''),
    ).rejects.toThrow();
  });

  it('rejects whitespace-only content', async () => {
    await expect(
      client.sendMessage(TEST_CHANNEL, '   \n\t  '),
    ).rejects.toThrow();
  });

  it('rejects invalid channel name', async () => {
    await expect(
      client.sendMessage('INVALID CHANNEL!!!', 'test'),
    ).rejects.toThrow();
  });

  it('rejects channel name starting with hyphen', async () => {
    await expect(
      client.sendMessage('-bad-name', 'test'),
    ).rejects.toThrow();
  });

  it('rejects oversized channel name (>100 chars)', async () => {
    await expect(
      client.sendMessage('a'.repeat(101), 'test'),
    ).rejects.toThrow();
  });
});

// ── Pagination ────────────────────────────────────────────────────────────

describe('pagination', () => {
  it('supports before parameter for messages', async () => {
    const first = (await client.readMessages(TEST_CHANNEL, 2)) as any;
    expect(first.data.messages.length).toBeGreaterThanOrEqual(1);

    const messages = first.data.messages;
    const oldest = messages[messages.length - 1];
    const before = oldest.created_at;

    const second = (await client.readMessages(
      TEST_CHANNEL,
      5,
      before,
    )) as any;
    expect(second.data.messages).toBeInstanceOf(Array);

    for (const msg of second.data.messages) {
      expect(new Date(msg.created_at).getTime()).toBeLessThan(
        new Date(before).getTime(),
      );
    }
  });

  it('caps limit at 200', async () => {
    // Request 999 messages — server should cap at 200
    const result = (await client.readMessages(TEST_CHANNEL, 999)) as any;
    expect(result.data.messages.length).toBeLessThanOrEqual(200);
  });
});

// ── Response wrapping (prompt injection boundary) ─────────────────────────

describe('response wrapping', () => {
  it('all v2 responses include _airchat boundary', async () => {
    const board = (await client.checkBoard()) as any;
    expect(board._airchat).toBe('response');
    expect(board._notice).toContain('agent-generated content');

    const channels = (await client.listChannels()) as any;
    expect(channels._airchat).toBe('response');

    const messages = (await client.readMessages(TEST_CHANNEL, 1)) as any;
    expect(messages._airchat).toBe('response');

    const search = (await client.searchMessages('test')) as any;
    expect(search._airchat).toBe('response');
  });
});
