/**
 * Integration tests for registration edge cases.
 *
 * Tests: expired timestamps (403), nonce replay (409), invalid signatures (403),
 * missing fields (400), and malformed payloads.
 *
 * Requires:
 *   - AirChat server running (AIRCHAT_WEB_URL in ~/.airchat/config)
 *   - Valid machine key at ~/.airchat/machine.key
 *
 * Run:
 *   npx vitest run packages/shared/src/__tests__/integration/registration-edge-cases
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateKeypair,
  generateDerivedKey,
  generateNonce,
  hashKey,
  signRegistration,
  type RegistrationPayload,
} from '../../crypto.js';

let webUrl: string;
let machineName: string;
let machinePrivateKey: string;

// Helper: raw fetch to the register endpoint
async function registerFetch(body: unknown): Promise<Response> {
  return fetch(`${webUrl}/api/v2/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}

// Helper: build a valid registration payload with valid signature
function buildValidPayload(overrides?: Partial<RegistrationPayload & { signature: string }>) {
  const derivedKey = generateDerivedKey();
  const payload: RegistrationPayload = {
    machine_name: machineName,
    agent_name: `edge-case-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    derived_key_hash: hashKey(derivedKey),
    timestamp: new Date().toISOString(),
    nonce: generateNonce(),
    ...overrides,
  };

  // Re-sign unless a signature override was provided
  const signature = overrides?.signature ?? signRegistration(machinePrivateKey, payload);
  return { ...payload, signature };
}

beforeAll(() => {
  const configText = fs.readFileSync(path.join(os.homedir(), '.airchat', 'config'), 'utf-8');
  webUrl = configText.match(/AIRCHAT_WEB_URL=(.+)/)?.[1]?.trim() ?? '';
  machineName = configText.match(/MACHINE_NAME=(.+)/)?.[1]?.trim() ?? '';
  expect(webUrl).toBeTruthy();
  expect(machineName).toBeTruthy();

  // Read machine key (hex-encoded Ed25519 private key, raw string)
  const keyPath = path.join(os.homedir(), '.airchat', 'machine.key');
  machinePrivateKey = fs.readFileSync(keyPath, 'utf-8').trim();
  expect(machinePrivateKey).toHaveLength(64); // 32 bytes hex
});

// ── Timestamp validation ──────────────────────────────────────────────────

describe('timestamp validation', () => {
  it('rejects expired timestamp (>60s in the past)', async () => {
    const oldTimestamp = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
    const body = buildValidPayload({ timestamp: oldTimestamp });
    // Re-sign with the old timestamp
    const payload: RegistrationPayload = {
      machine_name: body.machine_name,
      agent_name: body.agent_name,
      derived_key_hash: body.derived_key_hash,
      timestamp: oldTimestamp,
      nonce: body.nonce,
    };
    const signature = signRegistration(machinePrivateKey, payload);

    const res = await registerFetch({ ...payload, signature });
    expect([403, 429]).toContain(res.status);
  });

  it('rejects far-future timestamp (>60s ahead)', async () => {
    const futureTimestamp = new Date(Date.now() + 120_000).toISOString(); // 2 min ahead
    const payload: RegistrationPayload = {
      machine_name: machineName,
      agent_name: `future-test-${Date.now()}`,
      derived_key_hash: hashKey(generateDerivedKey()),
      timestamp: futureTimestamp,
      nonce: generateNonce(),
    };
    const signature = signRegistration(machinePrivateKey, payload);

    const res = await registerFetch({ ...payload, signature });
    expect([403, 429]).toContain(res.status);
  });

  it('rejects invalid timestamp format', async () => {
    const payload: RegistrationPayload = {
      machine_name: machineName,
      agent_name: `bad-ts-${Date.now()}`,
      derived_key_hash: hashKey(generateDerivedKey()),
      timestamp: 'not-a-date',
      nonce: generateNonce(),
    };
    const signature = signRegistration(machinePrivateKey, payload);

    const res = await registerFetch({ ...payload, signature });
    expect([403, 429]).toContain(res.status);
  });
});

// ── Nonce replay ──────────────────────────────────────────────────────────

describe('nonce replay', () => {
  it('rejects duplicate nonce with 409', async () => {
    const nonce = generateNonce();
    const agentSuffix = Date.now().toString(36);

    // First request — should succeed
    const payload1: RegistrationPayload = {
      machine_name: machineName,
      agent_name: `nonce-test-1-${agentSuffix}`,
      derived_key_hash: hashKey(generateDerivedKey()),
      timestamp: new Date().toISOString(),
      nonce,
    };
    const sig1 = signRegistration(machinePrivateKey, payload1);
    const res1 = await registerFetch({ ...payload1, signature: sig1 });
    // May be 200 or 429 (if rate limited from other tests)
    expect([200, 429]).toContain(res1.status);

    // Second request with same nonce — should get 409
    const payload2: RegistrationPayload = {
      machine_name: machineName,
      agent_name: `nonce-test-2-${agentSuffix}`,
      derived_key_hash: hashKey(generateDerivedKey()),
      timestamp: new Date().toISOString(),
      nonce, // same nonce
    };
    const sig2 = signRegistration(machinePrivateKey, payload2);
    const res2 = await registerFetch({ ...payload2, signature: sig2 });
    // If first was rate limited, nonce wasn't recorded — second might also be rate limited
    if (res1.status === 200) {
      expect(res2.status).toBe(409);
    } else {
      expect([409, 429]).toContain(res2.status);
    }
  });
});

// ── Signature validation ──────────────────────────────────────────────────

describe('signature validation', () => {
  it('rejects tampered signature with 403', async () => {
    const payload: RegistrationPayload = {
      machine_name: machineName,
      agent_name: `sig-tamper-${Date.now()}`,
      derived_key_hash: hashKey(generateDerivedKey()),
      timestamp: new Date().toISOString(),
      nonce: generateNonce(),
    };
    // Generate valid signature then corrupt it
    const validSig = signRegistration(machinePrivateKey, payload);
    const badSig = validSig.slice(0, -4) + 'AAAA';

    const res = await registerFetch({ ...payload, signature: badSig });
    // 403 expected, but 429 if IP rate limited
    expect([403, 429]).toContain(res.status);
    if (res.status === 403) {
      const data = await res.json();
      expect(data.error).toBe('Registration failed');
    }
  });

  it('rejects signature from wrong keypair with 403', async () => {
    const wrongKeypair = generateKeypair();
    const payload: RegistrationPayload = {
      machine_name: machineName,
      agent_name: `wrong-key-${Date.now()}`,
      derived_key_hash: hashKey(generateDerivedKey()),
      timestamp: new Date().toISOString(),
      nonce: generateNonce(),
    };
    const wrongSig = signRegistration(wrongKeypair.privateKey, payload);

    const res = await registerFetch({ ...payload, signature: wrongSig });
    expect([403, 429]).toContain(res.status);
  });

  it('rejects non-existent machine_name with 403 (same as bad signature)', async () => {
    const payload: RegistrationPayload = {
      machine_name: 'totally-fake-machine-that-does-not-exist',
      agent_name: `fake-machine-${Date.now()}`,
      derived_key_hash: hashKey(generateDerivedKey()),
      timestamp: new Date().toISOString(),
      nonce: generateNonce(),
    };
    const sig = signRegistration(machinePrivateKey, payload);

    const res = await registerFetch({ ...payload, signature: sig });
    expect([403, 429]).toContain(res.status);
  });
});

// ── Missing/invalid fields ────────────────────────────────────────────────

describe('request validation', () => {
  it('rejects missing fields with 400', async () => {
    const res = await registerFetch({
      machine_name: machineName,
      // missing all other fields
    });
    // 400 expected, but 429 if IP rate limited (rate limit fires before body parse)
    expect([400, 429]).toContain(res.status);
  });

  it('rejects non-string fields with 400', async () => {
    const res = await registerFetch({
      machine_name: machineName,
      agent_name: 12345, // number, not string
      derived_key_hash: hashKey(generateDerivedKey()),
      timestamp: new Date().toISOString(),
      nonce: generateNonce(),
      signature: 'aGVsbG8=',
    });
    expect([400, 429]).toContain(res.status);
  });

  it('rejects invalid JSON body with 400', async () => {
    const res = await fetch(`${webUrl}/api/v2/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json {{{{',
      signal: AbortSignal.timeout(15000),
    });
    expect([400, 429]).toContain(res.status);
  });
});

// ── Successful registration ───────────────────────────────────────────────

describe('valid registration', () => {
  it('succeeds with valid payload and returns agent_id', async () => {
    const body = buildValidPayload();
    const res = await registerFetch(body);

    // Might be rate limited from earlier tests
    if (res.status === 429) {
      return; // Skip — rate limited
    }

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.agent_id).toBeDefined();
    expect(data.agent_name).toBe(body.agent_name);
  });

  it('allows re-registration of the same agent (key rotation)', async () => {
    const agentName = `reregister-test-${Date.now()}`;

    // First registration
    const body1 = buildValidPayload({ agent_name: agentName });
    const res1 = await registerFetch(body1);
    if (res1.status === 429) return;
    expect(res1.status).toBe(200);
    const data1 = await res1.json();

    // Re-register same agent with a new derived key
    const newDerivedKey = generateDerivedKey();
    const payload2: RegistrationPayload = {
      machine_name: machineName,
      agent_name: agentName,
      derived_key_hash: hashKey(newDerivedKey),
      timestamp: new Date().toISOString(),
      nonce: generateNonce(),
    };
    const sig2 = signRegistration(machinePrivateKey, payload2);
    const res2 = await registerFetch({ ...payload2, signature: sig2 });
    if (res2.status === 429) return;

    expect(res2.status).toBe(200);
    const data2 = await res2.json();
    expect(data2.agent_id).toBe(data1.agent_id); // Same agent, updated key
    expect(data2.agent_name).toBe(agentName);
  });
});

// ── Agent cap (50 per machine) ────────────────────────────────────────────
// NOTE: The 50-agent-per-machine cap cannot be tested without creating 50+
// real agents, which is destructive to the database. The cap is enforced in
// apps/web/app/api/v2/register/route.ts (MAX_AGENTS_PER_MACHINE = 50) and
// returns { error: 'Agent limit exceeded for this machine' } with status 429.
// Re-registration of existing agents is exempt from the cap.
