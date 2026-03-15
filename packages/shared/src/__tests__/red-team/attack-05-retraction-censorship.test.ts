/**
 * Red Team Attack #5: Retraction as Censorship
 *
 * Verifies that retraction signatures are mandatory and that
 * retractions can only come from authorized sources.
 */

import { describe, it, expect } from 'vitest';
import { signRetraction, verifyRetraction } from '../../gossip/envelope.js';
import { generateKeypair } from '../../crypto.js';
import { deriveFingerprint } from '../../gossip/instance-identity.js';

describe('Attack 05: Retraction Censorship', () => {
  const originKeypair = generateKeypair();
  const originFingerprint = deriveFingerprint(originKeypair.publicKey);

  const attackerKeypair = generateKeypair();
  const attackerFingerprint = deriveFingerprint(attackerKeypair.publicKey);

  it('rejects unsigned retraction', () => {
    const retraction = {
      retracted_message_id: '12345678-1234-1234-1234-123456789012',
      reason: 'censorship attempt',
      retracted_by: attackerFingerprint,
      retracted_at: new Date().toISOString(),
      signature: '', // Empty
    };

    const valid = verifyRetraction(attackerKeypair.publicKey, retraction);
    expect(valid).toBe(false);
  });

  it('rejects retraction signed by wrong key', () => {
    const unsigned = {
      retracted_message_id: '12345678-1234-1234-1234-123456789012',
      reason: 'censorship attempt',
      retracted_by: attackerFingerprint,
      retracted_at: new Date().toISOString(),
    };

    // Attacker signs with their key
    const signed = signRetraction(attackerKeypair.privateKey, unsigned);

    // Verify against origin's key — should fail
    const valid = verifyRetraction(originKeypair.publicKey, signed);
    expect(valid).toBe(false);
  });

  it('accepts retraction signed by correct key', () => {
    const unsigned = {
      retracted_message_id: '12345678-1234-1234-1234-123456789012',
      reason: 'legitimate retraction',
      retracted_by: originFingerprint,
      retracted_at: new Date().toISOString(),
    };

    const signed = signRetraction(originKeypair.privateKey, unsigned);
    const valid = verifyRetraction(originKeypair.publicKey, signed);
    expect(valid).toBe(true);
  });

  it('rejects retraction with tampered message_id', () => {
    const unsigned = {
      retracted_message_id: '12345678-1234-1234-1234-123456789012',
      reason: 'retraction',
      retracted_by: originFingerprint,
      retracted_at: new Date().toISOString(),
    };

    const signed = signRetraction(originKeypair.privateKey, unsigned);

    // Tamper — try to retract a different message
    signed.retracted_message_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const valid = verifyRetraction(originKeypair.publicKey, signed);
    expect(valid).toBe(false);
  });
});
