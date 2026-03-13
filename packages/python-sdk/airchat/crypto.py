"""Ed25519 cryptographic utilities for AirChat v2 auth.

Handles derived key generation, signing, and hashing for the
asymmetric registration + symmetric fast-path auth model.

Requires the `cryptography` library (Ed25519 support).
"""

from __future__ import annotations

import hashlib
import json
import os

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
)
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)


def generate_derived_key() -> str:
    """Generate a random 32-byte derived key, returned as hex."""
    return os.urandom(32).hex()


def generate_nonce() -> str:
    """Generate a random 16-byte nonce, returned as hex."""
    return os.urandom(16).hex()


def hash_key(key: str) -> str:
    """SHA-256 hash of a key string, returned as hex."""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def sign_registration(
    private_key_seed_hex: str,
    machine_name: str,
    agent_name: str,
    derived_key_hash: str,
    timestamp: str,
    nonce: str,
) -> str:
    """Sign a registration payload with an Ed25519 private key.

    The signed message is a canonical JSON array of the five fields:
        json.dumps([machine_name, agent_name, derived_key_hash, timestamp, nonce],
                   separators=(',', ':'))

    Args:
        private_key_seed_hex: 32-byte Ed25519 private key seed as hex.
        machine_name: Machine name.
        agent_name: Agent name.
        derived_key_hash: SHA-256 hex hash of the derived key.
        timestamp: ISO-8601 timestamp string.
        nonce: Random hex nonce.

    Returns:
        Base64-encoded Ed25519 signature.

    Test vector (Section 12 of auth-rewrite-plan.md):
        Private key seed: c1881a80dc2977686b2aa45191964c95fb31f486195bda311f6fd90b46f870fe
        Public key:       9e4ae8a6f1ba95c48b0f9849551886eb3ffb01afb96c1f7ac845e3edd2d62016
        machine_name:     "test-machine"
        agent_name:       "test-machine-myproject"
        derived_key_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        timestamp:        "2026-01-01T00:00:00Z"
        nonce:            "00000000000000000000000000000000"
        Expected sig (b64): 6o9Ltmp5MDMUf+dfLWimuXx93HG5p3cDfphmPod2KHQSzonoS2hwtsTYYjPIkvyXx54TmvDJhk1jbpGzcrKTCw==
    """
    import base64

    seed = bytes.fromhex(private_key_seed_hex)
    private_key = Ed25519PrivateKey.from_private_bytes(seed)

    payload = json.dumps(
        [machine_name, agent_name, derived_key_hash, timestamp, nonce],
        separators=(",", ":"),
    )
    signature = private_key.sign(payload.encode("utf-8"))
    return base64.b64encode(signature).decode("ascii")


def load_private_key_hex(key_path: str) -> str:
    """Read an Ed25519 private key file and return the 32-byte seed as hex.

    Supports two formats:
    - Raw hex (64 hex chars on a single line)
    - PEM-encoded Ed25519 private key
    """
    from pathlib import Path

    content = Path(key_path).read_text().strip()

    # Raw hex format (64 hex chars = 32 bytes)
    if len(content) == 64 and all(c in "0123456789abcdefABCDEF" for c in content):
        return content.lower()

    # PEM format
    if content.startswith("-----BEGIN"):
        from cryptography.hazmat.primitives.serialization import load_pem_private_key

        private_key = load_pem_private_key(content.encode("utf-8"), password=None)
        if not isinstance(private_key, Ed25519PrivateKey):
            raise ValueError("PEM file does not contain an Ed25519 private key")
        # Extract the 32-byte seed from the private key
        raw = private_key.private_bytes(
            Encoding.Raw, PrivateFormat.Raw, NoEncryption()
        )
        return raw.hex()

    raise ValueError(
        f"Unrecognized key format in {key_path}. "
        "Expected 64 hex chars or PEM-encoded Ed25519 key."
    )


def get_public_key_hex(private_key_seed_hex: str) -> str:
    """Derive the Ed25519 public key from a private key seed.

    Returns the 32-byte public key as hex.
    """
    seed = bytes.fromhex(private_key_seed_hex)
    private_key = Ed25519PrivateKey.from_private_bytes(seed)
    public_key = private_key.public_key()
    raw = public_key.public_bytes(Encoding.Raw, PublicFormat.Raw)
    return raw.hex()
