/**
 * Instance identity management for AirChat gossip layer.
 *
 * Each AirChat instance has an Ed25519 keypair that identifies it
 * in the federation network. The keypair is generated on first boot
 * and stored at ~/.airchat/instance.key (private) and instance.pub (public).
 *
 * The fingerprint (first 16 hex chars of SHA-256 of the public key)
 * serves as the canonical instance ID in gossip envelopes and trust.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import crypto from 'node:crypto';
import { generateKeypair, hashKey } from '../crypto.js';

export interface InstanceIdentity {
  publicKey: string;    // Ed25519 public key (hex, 64 chars)
  privateKey: string;   // Ed25519 private key seed (hex, 64 chars)
  fingerprint: string;  // First 16 hex chars of SHA-256(publicKey)
}

/**
 * Derive a fingerprint from a public key.
 * First 16 hex characters of SHA-256(publicKeyHex).
 */
export function deriveFingerprint(publicKeyHex: string): string {
  return hashKey(publicKeyHex).slice(0, 16);
}

/**
 * Sign arbitrary data with the instance private key.
 * Returns a base64-encoded Ed25519 signature.
 */
export function signData(privateKeyHex: string, data: string): string {
  const seed = Buffer.from(privateKeyHex, 'hex');
  const pkcs8Header = Buffer.from('302e020100300506032b657004220420', 'hex');
  const pkcs8Der = Buffer.concat([pkcs8Header, seed]);
  const key = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });
  const signature = crypto.sign(null, Buffer.from(data, 'utf-8'), key);
  return signature.toString('base64');
}

/**
 * Verify a signature against a public key.
 */
export function verifySignature(publicKeyHex: string, data: string, signatureBase64: string): boolean {
  const raw = Buffer.from(publicKeyHex, 'hex');
  const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
  const spkiDer = Buffer.concat([spkiHeader, raw]);
  const key = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
  const signature = Buffer.from(signatureBase64, 'base64');
  return crypto.verify(null, Buffer.from(data, 'utf-8'), key, signature);
}

/**
 * Get the default AirChat config directory.
 */
function getAirchatDir(): string {
  return join(homedir(), '.airchat');
}

/**
 * Load or generate the instance keypair.
 *
 * If keys exist at ~/.airchat/instance.key and instance.pub, loads them.
 * If not, generates a new keypair and saves it.
 *
 * @param configDir - Override config directory (default: ~/.airchat)
 */
export function loadOrCreateInstanceIdentity(configDir?: string): InstanceIdentity {
  const dir = configDir ?? getAirchatDir();
  const keyPath = join(dir, 'instance.key');
  const pubPath = join(dir, 'instance.pub');

  // Try to load existing keys
  if (existsSync(keyPath) && existsSync(pubPath)) {
    const privateKey = readFileSync(keyPath, 'utf-8').trim();
    const publicKey = readFileSync(pubPath, 'utf-8').split('\n')[0].trim();
    const fingerprint = deriveFingerprint(publicKey);
    return { publicKey, privateKey, fingerprint };
  }

  // Generate new keypair
  const { publicKey, privateKey } = generateKeypair();
  const fingerprint = deriveFingerprint(publicKey);

  // Ensure directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Save private key (restrictive permissions).
  // The `mode` option only applies when the file is created -- if instance.key
  // already exists with looser permissions (an older release, a partially
  // written state, or a file planted by another local user), the key would be
  // written into it and the mode silently ignored. chmod unconditionally after
  // writing so the permissions hold either way.
  writeFileSync(keyPath, privateKey + '\n', { mode: 0o600 });
  chmodSync(keyPath, 0o600);

  // Save public key with fingerprint for easy reference
  writeFileSync(pubPath, `${publicKey}\n# fingerprint: ${fingerprint}\n`, { mode: 0o644 });

  return { publicKey, privateKey, fingerprint };
}

/**
 * Load instance identity without generating (returns null if not found).
 */
export function loadInstanceIdentity(configDir?: string): InstanceIdentity | null {
  const dir = configDir ?? getAirchatDir();
  const keyPath = join(dir, 'instance.key');
  const pubPath = join(dir, 'instance.pub');

  if (!existsSync(keyPath) || !existsSync(pubPath)) return null;

  const privateKey = readFileSync(keyPath, 'utf-8').trim();
  const publicKey = readFileSync(pubPath, 'utf-8').split('\n')[0].trim();
  const fingerprint = deriveFingerprint(publicKey);
  return { publicKey, privateKey, fingerprint };
}
