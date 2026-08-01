import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadOrCreateInstanceIdentity } from '../gossip/instance-identity.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'airchat-identity-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadOrCreateInstanceIdentity', () => {
  it('creates a keypair and persists both halves', () => {
    const identity = loadOrCreateInstanceIdentity(dir);

    expect(identity.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(dir, 'instance.key'))).toBe(true);
    expect(existsSync(join(dir, 'instance.pub'))).toBe(true);
  });

  it('is stable across calls', () => {
    const first = loadOrCreateInstanceIdentity(dir);
    const second = loadOrCreateInstanceIdentity(dir);
    expect(second).toEqual(first);
  });

  it('writes the private key with owner-only permissions', () => {
    loadOrCreateInstanceIdentity(dir);
    const mode = statSync(join(dir, 'instance.key')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // Regression: `mode` applies only at creation, so a pre-existing file with
  // loose permissions would have kept them while receiving the private key.
  // The write now uses O_EXCL, so an existing key is adopted, never overwritten
  // -- this is the concurrent-startup case, where another process won the race.
  it('adopts a pre-existing valid key rather than overwriting it', () => {
    const keyPath = join(dir, 'instance.key');
    const planted = 'a'.repeat(64);
    writeFileSync(keyPath, `${planted}\n`, { mode: 0o644 });

    const identity = loadOrCreateInstanceIdentity(dir);

    expect(readFileSync(keyPath, 'utf-8').trim()).toBe(planted);
    expect(identity.privateKey).toBe(planted);
    expect(identity.publicKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails with an actionable error when the existing key is unusable', () => {
    writeFileSync(join(dir, 'instance.key'), 'not-a-key\n', { mode: 0o644 });

    // Without this the caller sees "asn1 encoding routines::not enough data",
    // which gives no hint that a file was found and refused.
    expect(() => loadOrCreateInstanceIdentity(dir)).toThrow(/not a valid Ed25519 private key/);
    expect(() => loadOrCreateInstanceIdentity(dir)).toThrow(/Refusing to overwrite/);
  });

  // The .pub half can go missing without the identity changing: the public key
  // is recomputed from the private one rather than regenerating the keypair,
  // which would change the fingerprint and orphan every peer relationship.
  it('recovers the public half without changing the fingerprint', () => {
    const original = loadOrCreateInstanceIdentity(dir);
    rmSync(join(dir, 'instance.pub'));

    const recovered = loadOrCreateInstanceIdentity(dir);

    expect(recovered.privateKey).toBe(original.privateKey);
    expect(recovered.publicKey).toBe(original.publicKey);
    expect(recovered.fingerprint).toBe(original.fingerprint);
    expect(existsSync(join(dir, 'instance.pub'))).toBe(true);
  });
});
