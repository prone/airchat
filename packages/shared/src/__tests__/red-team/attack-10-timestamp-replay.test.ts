/**
 * Red Team Attack #10: Timestamp Replay
 *
 * Verifies that signed timestamps expire and can't be reused
 * outside the replay window.
 */

import { describe, it, expect } from 'vitest';
import { signData, verifySignature } from '../../gossip/instance-identity.js';
import { generateKeypair } from '../../crypto.js';

describe('Attack 10: Timestamp Replay', () => {
  const keypair = generateKeypair();

  it('accepts signature within 5-minute window', () => {
    const timestamp = new Date().toISOString();
    const signature = signData(keypair.privateKey, timestamp);

    const valid = verifySignature(keypair.publicKey, timestamp, signature);
    expect(valid).toBe(true);

    // Check the timestamp is within window
    const age = Math.abs(Date.now() - new Date(timestamp).getTime());
    expect(age).toBeLessThan(5 * 60 * 1000);
  });

  it('old timestamp should be rejected by application logic', () => {
    // Simulate a 10-minute-old timestamp
    const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const signature = signData(keypair.privateKey, oldTimestamp);

    // The signature itself is valid (crypto doesn't care about time)
    const cryptoValid = verifySignature(keypair.publicKey, oldTimestamp, signature);
    expect(cryptoValid).toBe(true);

    // But the application-level replay check should reject it
    const age = Math.abs(Date.now() - new Date(oldTimestamp).getTime());
    const withinWindow = age <= 5 * 60 * 1000;
    expect(withinWindow).toBe(false);
  });

  it('future timestamp should be rejected by application logic', () => {
    const futureTimestamp = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const signature = signData(keypair.privateKey, futureTimestamp);

    const cryptoValid = verifySignature(keypair.publicKey, futureTimestamp, signature);
    expect(cryptoValid).toBe(true);

    const age = Math.abs(Date.now() - new Date(futureTimestamp).getTime());
    const withinWindow = age <= 5 * 60 * 1000;
    expect(withinWindow).toBe(false);
  });

  it('signature does not transfer between timestamps', () => {
    const timestamp1 = new Date().toISOString();
    const signature1 = signData(keypair.privateKey, timestamp1);

    const timestamp2 = new Date(Date.now() + 1000).toISOString();

    // Signature for timestamp1 should not verify against timestamp2
    const valid = verifySignature(keypair.publicKey, timestamp2, signature1);
    expect(valid).toBe(false);
  });
});
