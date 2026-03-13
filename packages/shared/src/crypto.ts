import crypto from 'node:crypto';

export interface RegistrationPayload {
  machine_name: string;
  agent_name: string;
  derived_key_hash: string;
  timestamp: string;
  nonce: string;
}

/**
 * Generate an Ed25519 keypair.
 * Returns hex-encoded raw keys (32 bytes each).
 */
export function generateKeypair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  // Export raw 32-byte keys in hex
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' });
  // SPKI DER for Ed25519 is 44 bytes: 12-byte header + 32-byte key
  const pubHex = pubRaw.subarray(pubRaw.length - 32).toString('hex');

  const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' });
  // PKCS8 DER for Ed25519 is 48 bytes: 16-byte header + 32-byte seed
  const privHex = privRaw.subarray(privRaw.length - 32).toString('hex');

  return { publicKey: pubHex, privateKey: privHex };
}

/**
 * Build the canonical signed message for registration.
 * Compact JSON array with no whitespace, fixed field order.
 */
function buildSignedMessage(payload: RegistrationPayload): string {
  return JSON.stringify([
    payload.machine_name,
    payload.agent_name,
    payload.derived_key_hash,
    payload.timestamp,
    payload.nonce,
  ]);
}

/**
 * Reconstruct an Ed25519 private key object from a 32-byte hex seed.
 */
function privateKeyFromHex(privateKeyHex: string): crypto.KeyObject {
  const seed = Buffer.from(privateKeyHex, 'hex');
  // PKCS8 DER wrapper for Ed25519: 16-byte header + 32-byte seed
  const pkcs8Header = Buffer.from(
    '302e020100300506032b657004220420',
    'hex'
  );
  const pkcs8Der = Buffer.concat([pkcs8Header, seed]);
  return crypto.createPrivateKey({
    key: pkcs8Der,
    format: 'der',
    type: 'pkcs8',
  });
}

/**
 * Reconstruct an Ed25519 public key object from a 32-byte hex key.
 */
function publicKeyFromHex(publicKeyHex: string): crypto.KeyObject {
  const raw = Buffer.from(publicKeyHex, 'hex');
  // SPKI DER wrapper for Ed25519: 12-byte header + 32-byte key
  const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
  const spkiDer = Buffer.concat([spkiHeader, raw]);
  return crypto.createPublicKey({
    key: spkiDer,
    format: 'der',
    type: 'spki',
  });
}

/**
 * Sign a registration payload with an Ed25519 private key.
 * Returns a base64-encoded signature.
 */
export function signRegistration(
  privateKeyHex: string,
  payload: RegistrationPayload
): string {
  const key = privateKeyFromHex(privateKeyHex);
  const message = Buffer.from(buildSignedMessage(payload), 'utf-8');
  const signature = crypto.sign(null, message, key);
  return signature.toString('base64');
}

/**
 * Verify an Ed25519 signature on a registration payload.
 * Returns true if the signature is valid.
 */
export function verifyRegistration(
  publicKeyHex: string,
  payload: RegistrationPayload,
  signatureBase64: string
): boolean {
  const key = publicKeyFromHex(publicKeyHex);
  const message = Buffer.from(buildSignedMessage(payload), 'utf-8');
  const signature = Buffer.from(signatureBase64, 'base64');
  return crypto.verify(null, message, key, signature);
}

/**
 * SHA256 hex digest of the input string.
 */
export function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Generate a random 256-bit derived key, hex encoded (64 chars).
 */
export function generateDerivedKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Generate a random 128-bit nonce, hex encoded (32 chars).
 */
export function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}
