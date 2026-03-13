import { describe, it, expect } from 'vitest';
import {
  generateKeypair,
  signRegistration,
  verifyRegistration,
  hashKey,
  generateDerivedKey,
  generateNonce,
  type RegistrationPayload,
} from '../crypto.js';

// Frozen test vector from the auth-rewrite-plan (Section 12)
const TEST_PRIVATE_KEY =
  'c1881a80dc2977686b2aa45191964c95fb31f486195bda311f6fd90b46f870fe';
const TEST_PUBLIC_KEY =
  '9e4ae8a6f1ba95c48b0f9849551886eb3ffb01afb96c1f7ac845e3edd2d62016';
const TEST_PAYLOAD: RegistrationPayload = {
  machine_name: 'test-machine',
  agent_name: 'test-machine-myproject',
  derived_key_hash:
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  timestamp: '2026-01-01T00:00:00Z',
  nonce: '00000000000000000000000000000000',
};
const EXPECTED_SIGNATURE_BASE64 =
  '6o9Ltmp5MDMUf+dfLWimuXx93HG5p3cDfphmPod2KHQSzonoS2hwtsTYYjPIkvyXx54TmvDJhk1jbpGzcrKTCw==';

describe('crypto: frozen test vector', () => {
  it('produces the expected signature for the test vector', () => {
    const sig = signRegistration(TEST_PRIVATE_KEY, TEST_PAYLOAD);
    expect(sig).toBe(EXPECTED_SIGNATURE_BASE64);
  });

  it('verifies the expected signature against the test public key', () => {
    const valid = verifyRegistration(
      TEST_PUBLIC_KEY,
      TEST_PAYLOAD,
      EXPECTED_SIGNATURE_BASE64
    );
    expect(valid).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const tampered =
      'AAAA' + EXPECTED_SIGNATURE_BASE64.slice(4);
    const valid = verifyRegistration(
      TEST_PUBLIC_KEY,
      TEST_PAYLOAD,
      tampered
    );
    expect(valid).toBe(false);
  });

  it('rejects a tampered payload', () => {
    const tamperedPayload = { ...TEST_PAYLOAD, agent_name: 'wrong-name' };
    const valid = verifyRegistration(
      TEST_PUBLIC_KEY,
      tamperedPayload,
      EXPECTED_SIGNATURE_BASE64
    );
    expect(valid).toBe(false);
  });
});

describe('crypto: sign + verify round-trip', () => {
  it('round-trips with a generated keypair', () => {
    const { publicKey, privateKey } = generateKeypair();
    const payload: RegistrationPayload = {
      machine_name: 'my-machine',
      agent_name: 'my-machine-project',
      derived_key_hash: hashKey('some-derived-key'),
      timestamp: new Date().toISOString(),
      nonce: generateNonce(),
    };

    const sig = signRegistration(privateKey, payload);
    expect(verifyRegistration(publicKey, payload, sig)).toBe(true);
  });

  it('fails verification with wrong public key', () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    const payload: RegistrationPayload = {
      machine_name: 'machine',
      agent_name: 'machine-agent',
      derived_key_hash: hashKey('key'),
      timestamp: new Date().toISOString(),
      nonce: generateNonce(),
    };

    const sig = signRegistration(kp1.privateKey, payload);
    expect(verifyRegistration(kp2.publicKey, payload, sig)).toBe(false);
  });
});

describe('generateKeypair', () => {
  it('produces 64-char hex strings (32 bytes)', () => {
    const { publicKey, privateKey } = generateKeypair();
    expect(publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(privateKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different keys each call', () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    expect(kp1.publicKey).not.toBe(kp2.publicKey);
    expect(kp1.privateKey).not.toBe(kp2.privateKey);
  });
});

describe('generateDerivedKey', () => {
  it('produces a 64-char hex string', () => {
    const key = generateDerivedKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces unique values', () => {
    const a = generateDerivedKey();
    const b = generateDerivedKey();
    expect(a).not.toBe(b);
  });
});

describe('generateNonce', () => {
  it('produces a 32-char hex string', () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('hashKey', () => {
  it('produces expected SHA256 for empty string', () => {
    // SHA256("") is the well-known hash used in the test vector
    expect(hashKey('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  it('produces expected SHA256 for a known input', () => {
    // SHA256("hello") — well-known value
    expect(hashKey('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    );
  });

  it('produces 64-char hex strings', () => {
    expect(hashKey('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});
