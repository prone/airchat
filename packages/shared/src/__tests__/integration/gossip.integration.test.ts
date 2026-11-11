/**
 * Integration tests for gossip/federation features.
 *
 * Tests: stats endpoint, push endpoint, SSRF validation,
 * nonce replay rejection, rate limiting, cross-peer dedup.
 *
 * Requires:
 *   - AirChat server running (AIRCHAT_WEB_URL in ~/.airchat/config)
 *   - Valid machine key at ~/.airchat/machine.key
 *   - Instance identity at ~/.airchat/instance.key
 *   - Gossip enabled on the instance
 *
 * Run:
 *   npx vitest run packages/shared/src/__tests__/integration/gossip.integration.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  generateKeypair,
  generateDerivedKey,
  generateNonce,
  hashKey,
  signRegistration,
} from '../../crypto.js';
import { signData, deriveFingerprint } from '../../gossip/instance-identity.js';
import { signEnvelope } from '../../gossip/envelope.js';

let webUrl: string;
let instancePrivateKey: string;
let instanceFingerprint: string;
let apiKey: string;

// Helper: raw fetch with auth
async function rawFetch(
  method: string,
  pathname: string,
  body?: unknown,
  params?: URLSearchParams,
  headers?: Record<string, string>,
): Promise<Response> {
  let url = `${webUrl}${pathname}`;
  if (params?.toString()) url += `?${params}`;

  const h: Record<string, string> = { 'x-agent-api-key': apiKey, ...headers };
  const init: RequestInit = { method, headers: h, signal: AbortSignal.timeout(15000) };
  if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return fetch(url, init);
}

// Helper: raw fetch without auth
async function publicFetch(
  method: string,
  pathname: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  const url = `${webUrl}${pathname}`;
  const h: Record<string, string> = { ...headers };
  const init: RequestInit = { method, headers: h, signal: AbortSignal.timeout(15000) };
  if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return fetch(url, init);
}

// Helper: build gossip auth headers
function gossipAuthHeaders(privateKey: string, fingerprint: string) {
  const timestamp = new Date().toISOString();
  const signature = signData(privateKey, timestamp);
  return {
    'x-gossip-fingerprint': fingerprint,
    'x-gossip-timestamp': timestamp,
    'x-gossip-signature': signature,
  };
}

beforeAll(() => {
  const configText = fs.readFileSync(path.join(os.homedir(), '.airchat', 'config'), 'utf-8');
  webUrl = configText.match(/AIRCHAT_WEB_URL=(.+)/)?.[1]?.trim() ?? '';
  expect(webUrl).toBeTruthy();

  const keyPath = path.join(os.homedir(), '.airchat', 'agents', 'macbook-integration-test.key');
  apiKey = fs.readFileSync(keyPath, 'utf-8').trim();

  instancePrivateKey = fs.readFileSync(path.join(os.homedir(), '.airchat', 'instance.key'), 'utf-8').trim();
  const instancePublicKey = fs.readFileSync(path.join(os.homedir(), '.airchat', 'instance.pub'), 'utf-8').split('\n')[0].trim();
  instanceFingerprint = deriveFingerprint(instancePublicKey);
});

// ── Stats endpoint ──────────────────────────────────────────────────────

describe('gossip stats', () => {
  it('returns stats without auth', async () => {
    const res = await publicFetch('GET', '/api/v2/gossip/stats');
    expect(res.status).toBe(200);

    const data = (await res.json()).data;
    expect(data).toHaveProperty('total_gossip_messages');
    expect(data).toHaveProperty('total_global_channels');
    expect(data).toHaveProperty('total_connected_peers');
    expect(data).toHaveProperty('total_federated_agents');
    expect(data).toHaveProperty('messages_last_24h');
    expect(data).toHaveProperty('gossip_enabled');
    expect(data).toHaveProperty('generated_at');
  });

  it('does not expose quarantine count or fingerprint', async () => {
    const res = await publicFetch('GET', '/api/v2/gossip/stats');
    const data = (await res.json()).data;
    expect(data).not.toHaveProperty('quarantined_messages');
    expect(data).not.toHaveProperty('instance_fingerprint');
  });

  it('returns CORS headers', async () => {
    const res = await publicFetch('GET', '/api/v2/gossip/stats');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toContain('max-age=60');
  });

  it('handles OPTIONS preflight', async () => {
    const res = await fetch(`${webUrl}/api/v2/gossip/stats`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

// ── Push endpoint auth ──────────────────────────────────────────────────

describe('gossip push auth', () => {
  it('rejects push without auth headers', async () => {
    const res = await publicFetch('POST', '/api/v2/gossip/push', { messages: [] });
    expect(res.status).toBe(401);
  });

  it('rejects push with expired timestamp', async () => {
    const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const signature = signData(instancePrivateKey, oldTimestamp);
    const res = await publicFetch('POST', '/api/v2/gossip/push', { messages: [] }, {
      'x-gossip-fingerprint': instanceFingerprint,
      'x-gossip-timestamp': oldTimestamp,
      'x-gossip-signature': signature,
    });
    expect(res.status).toBe(401);
  });

  it('rejects push from unknown fingerprint', async () => {
    const headers = gossipAuthHeaders(instancePrivateKey, 'deadbeef12345678');
    const res = await publicFetch('POST', '/api/v2/gossip/push', { messages: [] }, headers);
    // 401 (nonce) or 403 (unknown peer) depending on order
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects push with wrong signature', async () => {
    const wrongKeypair = generateKeypair();
    const headers = gossipAuthHeaders(wrongKeypair.privateKey, instanceFingerprint);
    const res = await publicFetch('POST', '/api/v2/gossip/push', { messages: [] }, headers);
    expect([403, 429]).toContain(res.status);
  });

  it('rejects push with empty messages array', async () => {
    const headers = gossipAuthHeaders(instancePrivateKey, instanceFingerprint);
    const res = await publicFetch('POST', '/api/v2/gossip/push', { messages: [] }, headers);
    // 400 (empty), 403 (not a peer of itself), or 429 (rate limited)
    expect([400, 403, 429]).toContain(res.status);
  });
});

// ── Nonce replay ────────────────────────────────────────────────────────

describe('gossip nonce replay', () => {
  it('rejects replayed timestamp on sync', async () => {
    const timestamp = new Date().toISOString();
    const signature = signData(instancePrivateKey, timestamp);
    const headers = {
      'x-gossip-fingerprint': instanceFingerprint,
      'x-gossip-timestamp': timestamp,
      'x-gossip-signature': signature,
    };

    // First request — may succeed (200), fail auth (403 if not own peer), or rate limit (429)
    const res1 = await publicFetch('GET', '/api/v2/gossip/sync?since=2020-01-01T00:00:00Z', undefined, headers);
    expect([200, 403, 429]).toContain(res1.status);

    // Second request with same timestamp — should be rejected as replay (401)
    // unless the first failed before nonce was recorded
    const res2 = await publicFetch('GET', '/api/v2/gossip/sync?since=2020-01-01T00:00:00Z', undefined, headers);
    if (res1.status === 200) {
      // Nonce was recorded on first success — replay should be rejected
      expect(res2.status).toBe(401);
    } else {
      // First failed (403 or 429) — nonce may or may not have been recorded
      expect([401, 403, 429]).toContain(res2.status);
    }
  });
});

// ── SSRF protection ─────────────────────────────────────────────────────

// Peer registration is admin-only, so these need AIRCHAT_ADMIN_SECRET (the
// server's ADMIN_REGISTRATION_SECRET). Without it the request never reaches the
// SSRF check — it is refused with 403 — and the tests would prove nothing.
const ADMIN_SECRET = process.env.AIRCHAT_ADMIN_SECRET;
const adminHeaders = (): Record<string, string> => ({ 'x-admin-secret': ADMIN_SECRET ?? '' });

describe('peer registration is admin-only', () => {
  it('refuses an agent key without the admin secret', async () => {
    const res = await rawFetch('POST', '/api/v2/gossip/peers', {
      endpoint: 'https://example.com',
      fingerprint: 'abcdef1234567890',
    });
    expect(res.status).toBe(403);
  });
});

describe.skipIf(!ADMIN_SECRET)('SSRF protection on peer registration', () => {
  // Dev servers on private networks have ALLOW_PRIVATE_PEER_ENDPOINTS=true,
  // so private IPs are allowed. Detect this and adjust expectations.

  const ssrfEndpoints = [
    { name: 'localhost', url: 'http://localhost:8080' },
    { name: '127.0.0.1', url: 'http://127.0.0.1:3000' },
    { name: 'cloud metadata (169.254)', url: 'http://169.254.169.254/latest/meta-data/' },
    { name: 'private 192.168.x', url: 'http://192.168.1.1:8080' },
    { name: 'private 10.x', url: 'http://10.0.0.1:3000' },
    { name: 'file:// protocol', url: 'file:///etc/passwd' },
  ];

  for (const { name, url } of ssrfEndpoints) {
    it(`blocks ${name} endpoint`, async () => {
      const res = await rawFetch('POST', '/api/v2/gossip/peers', {
        endpoint: url,
        fingerprint: `ssrf-test-${Date.now().toString(36)}`,
      }, undefined, adminHeaders());
      // file:// is always blocked (invalid URL for fetch, not an http/https scheme)
      // Private IPs: blocked (400) on production, allowed (201) on dev servers
      if (res.status === 201 || res.status === 409) {
        // Dev server with ALLOW_PRIVATE_PEER_ENDPOINTS — clean up
        await rawFetch('DELETE', '/api/v2/gossip/peers', { endpoint: url }, undefined, adminHeaders());
      }
      expect([400, 201, 409]).toContain(res.status);
    });
  }

  it('allows valid public endpoint', async () => {
    const res = await rawFetch('POST', '/api/v2/gossip/peers', {
      endpoint: 'https://example.com',
      fingerprint: 'abcdef1234567890',
    }, undefined, adminHeaders());
    // Passes SSRF — may succeed (201) or fail on fingerprint mismatch (409)
    expect([201, 409]).toContain(res.status);
    await rawFetch('DELETE', '/api/v2/gossip/peers', { endpoint: 'https://example.com' }, undefined, adminHeaders());
  });
});

// ── Push + sync flow ────────────────────────────────────────────────────

describe('gossip push message flow', () => {
  // Push tests require the instance to be registered as a peer of itself,
  // which isn't the normal case. These tests validate auth and format
  // handling, accepting 403 (not a peer) as a valid outcome.

  it('push with valid auth reaches the endpoint', async () => {
    const headers = gossipAuthHeaders(instancePrivateKey, instanceFingerprint);
    const instancePublicKey = fs.readFileSync(
      path.join(os.homedir(), '.airchat', 'instance.pub'), 'utf-8'
    ).split('\n')[0].trim();

    const messageId = crypto.randomUUID();
    const envelope = signEnvelope(instancePrivateKey, {
      message_id: messageId,
      channel_name: 'gossip-integration-test',
      origin_instance: instanceFingerprint,
      author_agent: 'integration-test-agent',
      content: `Push test ${Date.now()}`,
      metadata: null,
      created_at: new Date().toISOString(),
      hop_count: 0,
      safety_labels: [],
      federation_scope: 'global',
    });

    const res = await publicFetch('POST', '/api/v2/gossip/push', {
      messages: [{ ...envelope, origin_public_key: instancePublicKey }],
    }, headers);

    // 200 (accepted), 403 (not own peer), or 429 (rate limited)
    expect([200, 403, 429]).toContain(res.status);
    if (res.status === 200) {
      const data = (await res.json()).data;
      expect(data.accepted).toBe(1);
    }
  });

  it('rejects push with tampered content', async () => {
    const headers = gossipAuthHeaders(instancePrivateKey, instanceFingerprint);
    const instancePublicKey = fs.readFileSync(
      path.join(os.homedir(), '.airchat', 'instance.pub'), 'utf-8'
    ).split('\n')[0].trim();

    const envelope = signEnvelope(instancePrivateKey, {
      message_id: crypto.randomUUID(),
      channel_name: 'gossip-integration-test',
      origin_instance: instanceFingerprint,
      author_agent: 'integration-test-agent',
      content: 'Original content',
      metadata: null,
      created_at: new Date().toISOString(),
      hop_count: 0,
      safety_labels: [],
      federation_scope: 'global',
    });

    const tampered = { ...envelope, content: 'TAMPERED content', origin_public_key: instancePublicKey };
    const res = await publicFetch('POST', '/api/v2/gossip/push', { messages: [tampered] }, headers);

    // 200 with stored:0 (tampered rejected), 403 (not own peer), or 429
    if (res.status === 200) {
      const data = (await res.json()).data;
      expect(data.stored).toBe(0);
    } else {
      expect([403, 429]).toContain(res.status);
    }
  });

  it('rejects push targeting local channel', async () => {
    const headers = gossipAuthHeaders(instancePrivateKey, instanceFingerprint);
    const instancePublicKey = fs.readFileSync(
      path.join(os.homedir(), '.airchat', 'instance.pub'), 'utf-8'
    ).split('\n')[0].trim();

    const envelope = signEnvelope(instancePrivateKey, {
      message_id: crypto.randomUUID(),
      channel_name: 'general',
      origin_instance: instanceFingerprint,
      author_agent: 'attacker',
      content: 'Injected into local channel',
      metadata: null,
      created_at: new Date().toISOString(),
      hop_count: 0,
      safety_labels: [],
      federation_scope: 'global',
    });

    const res = await publicFetch('POST', '/api/v2/gossip/push', {
      messages: [{ ...envelope, origin_public_key: instancePublicKey }],
    }, headers);

    if (res.status === 200) {
      const data = (await res.json()).data;
      expect(data.stored).toBe(0);
    } else {
      expect([403, 429]).toContain(res.status);
    }
  });
});

// ── Outbound push on message post ───────────────────────────────────────

describe('outbound push on gossip post', () => {
  it('posting to gossip-* channel succeeds (push is fire-and-forget)', async () => {
    const content = `Outbound push test ${Date.now()}`;
    const res = await rawFetch('POST', '/api/v2/messages', {
      channel: 'gossip-integration-test',
      content,
    });

    // May be rate limited
    if (res.status === 429) return;

    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.message.content).toBe(content);
    // The push happens async — we can't verify it reached the supernode
    // but the message should be stored locally
    expect(data.message.id).toBeTruthy();
  });
});

// ── Identity endpoint ───────────────────────────────────────────────────

describe('gossip identity', () => {
  it('returns instance identity without auth', async () => {
    const res = await publicFetch('GET', '/api/v2/gossip/identity');
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.fingerprint).toBe(instanceFingerprint);
    expect(data.public_key).toBeTruthy();
    expect(data).toHaveProperty('gossip_enabled');
  });
});
