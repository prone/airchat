"""Test crypto module against frozen test vectors from auth-rewrite-plan.md Section 12.

These values are frozen and cross-verified between Node.js and Python.
Do NOT change them.
"""

from airchat.crypto import (
    generate_derived_key,
    generate_nonce,
    get_public_key_hex,
    hash_key,
    sign_registration,
)

# Frozen test vector from auth-rewrite-plan.md Section 12
TEST_PRIVATE_KEY_SEED = (
    "c1881a80dc2977686b2aa45191964c95fb31f486195bda311f6fd90b46f870fe"
)
TEST_PUBLIC_KEY = (
    "9e4ae8a6f1ba95c48b0f9849551886eb3ffb01afb96c1f7ac845e3edd2d62016"
)
TEST_MACHINE_NAME = "test-machine"
TEST_AGENT_NAME = "test-machine-myproject"
TEST_DERIVED_KEY_HASH = (
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
)
TEST_TIMESTAMP = "2026-01-01T00:00:00Z"
TEST_NONCE = "00000000000000000000000000000000"
EXPECTED_SIGNATURE_B64 = (
    "6o9Ltmp5MDMUf+dfLWimuXx93HG5p3cDfphmPod2KHQSzonoS2hwtsTY"
    "YjPIkvyXx54TmvDJhk1jbpGzcrKTCw=="
)
EXPECTED_SIGNATURE_HEX = (
    "ea8f4bb66a793033147fe75f2d68a6b97c7ddc71b9a777037e98663e87762874"
    "12ce89e84b6870b6c4d86233c892fc97c79e139af0c9864d636e91b372b2930b"
)


def test_public_key_derivation():
    """Verify the public key derived from the test seed matches the expected value."""
    pub = get_public_key_hex(TEST_PRIVATE_KEY_SEED)
    assert pub == TEST_PUBLIC_KEY


def test_sign_registration_matches_test_vector():
    """Sign the frozen test payload and verify the signature matches exactly.

    This is the critical cross-language compatibility test. The Node.js
    crypto.sign() and Python Ed25519PrivateKey.sign() must produce the
    identical signature for the same inputs.
    """
    signature_b64 = sign_registration(
        TEST_PRIVATE_KEY_SEED,
        TEST_MACHINE_NAME,
        TEST_AGENT_NAME,
        TEST_DERIVED_KEY_HASH,
        TEST_TIMESTAMP,
        TEST_NONCE,
    )
    assert signature_b64 == EXPECTED_SIGNATURE_B64

    # Also verify hex representation
    import base64

    sig_bytes = base64.b64decode(signature_b64)
    assert sig_bytes.hex() == EXPECTED_SIGNATURE_HEX


def test_signature_verifies_with_public_key():
    """Verify the signature using the public key (round-trip check)."""
    import base64

    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    signature_b64 = sign_registration(
        TEST_PRIVATE_KEY_SEED,
        TEST_MACHINE_NAME,
        TEST_AGENT_NAME,
        TEST_DERIVED_KEY_HASH,
        TEST_TIMESTAMP,
        TEST_NONCE,
    )

    import json

    payload = json.dumps(
        [
            TEST_MACHINE_NAME,
            TEST_AGENT_NAME,
            TEST_DERIVED_KEY_HASH,
            TEST_TIMESTAMP,
            TEST_NONCE,
        ],
        separators=(",", ":"),
    )

    pub_key = Ed25519PublicKey.from_public_bytes(bytes.fromhex(TEST_PUBLIC_KEY))
    sig_bytes = base64.b64decode(signature_b64)
    # Raises InvalidSignature if verification fails
    pub_key.verify(sig_bytes, payload.encode("utf-8"))


def test_generate_derived_key_format():
    """Derived key should be 64 hex chars (32 bytes)."""
    key = generate_derived_key()
    assert len(key) == 64
    int(key, 16)  # Must be valid hex


def test_generate_nonce_format():
    """Nonce should be 32 hex chars (16 bytes)."""
    nonce = generate_nonce()
    assert len(nonce) == 32
    int(nonce, 16)  # Must be valid hex


def test_hash_key():
    """SHA-256 of empty string matches known value."""
    # SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    assert hash_key("") == (
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )
