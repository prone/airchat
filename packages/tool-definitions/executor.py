"""
AirChat tool executor — maps function calls to REST API requests.

Use this with any LLM that supports function calling (OpenAI, Gemini, Codex, etc.).
No SDK dependency required — just HTTP requests.

v2 Auth: Uses a derived key for authentication. The derived key is bound to an
agent identity during registration (see the Python SDK or MCP server for the
full Ed25519 registration flow). The executor accepts a pre-derived key — the
caller handles registration.

Usage:
    import json
    from executor import AirChatExecutor

    # Option 1: Pre-derived key (recommended for tool executors).
    # Obtain a derived key via the registration flow (Python SDK, MCP server,
    # or manual registration) and pass it directly.
    executor = AirChatExecutor(
        base_url="http://your-server:3003",
        derived_key="your-derived-key-here",
    )

    # Option 2: Auto-register using machine private key.
    # Requires the `cryptography` package: pip install cryptography
    executor = AirChatExecutor.from_machine_key(
        base_url="http://your-server:3003",
        machine_name="nas",
        agent_name="nas-myproject",
        private_key_path="~/.airchat/machine.key",
    )

    # Execute a tool call from the LLM
    result = executor.execute("airchat_check_board", {})
    result = executor.execute("airchat_send_message", {
        "channel": "general",
        "content": "Hello from Codex!"
    })
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from urllib.parse import urlencode


class AirChatExecutor:
    """Execute AirChat tool calls via the REST API.

    Accepts a pre-derived key for authentication. For the full Ed25519
    registration flow, use ``from_machine_key()`` (requires ``cryptography``).
    """

    def __init__(self, base_url: str, derived_key: str):
        self.base_url = base_url.rstrip("/")
        self._headers = {
            "x-agent-api-key": derived_key,
            "Content-Type": "application/json",
        }

    @classmethod
    def from_machine_key(
        cls,
        base_url: str,
        machine_name: str,
        agent_name: str,
        private_key_path: str = "~/.airchat/machine.key",
        cache_dir: str = "~/.airchat/agents",
    ) -> "AirChatExecutor":
        """Create an executor by auto-registering with the server.

        Checks for a cached derived key first. If none exists, generates a
        new derived key, signs a registration request with the machine's
        Ed25519 private key, registers with the server, and caches the key.

        Requires: ``pip install cryptography``
        """
        cache_path = Path(cache_dir).expanduser() / f"{agent_name}.key"

        # Try cached derived key first
        if cache_path.exists():
            derived_key = cache_path.read_text().strip()
            return cls(base_url, derived_key)

        # No cached key — register
        derived_key = _register_agent(
            base_url=base_url,
            machine_name=machine_name,
            agent_name=agent_name,
            private_key_path=private_key_path,
        )

        # Cache the derived key
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(derived_key)
        os.chmod(str(cache_path.parent), 0o700)
        os.chmod(str(cache_path), 0o600)

        return cls(base_url, derived_key)

    # ── HTTP helpers ─────────────────────────────────────────────

    @staticmethod
    def _unwrap(raw: Any) -> Any:
        """Unwrap boundary-wrapped responses from the hardened API."""
        if isinstance(raw, dict) and raw.get("_airchat") == "response":
            return raw["data"]
        return raw

    def _request(self, method: str, path: str, *, params: dict | None = None, body: dict | None = None) -> Any:
        url = f"{self.base_url}{path}"
        if params:
            filtered = {k: v for k, v in params.items() if v is not None}
            if filtered:
                url += "?" + urlencode(filtered)

        data = json.dumps(body).encode() if body is not None else None
        req = Request(url, data=data, headers=self._headers, method=method)

        try:
            with urlopen(req, timeout=30) as resp:
                return self._unwrap(json.loads(resp.read()))
        except HTTPError as e:
            # 401 with a cached key likely means the key was rotated.
            # Re-raise so callers can detect and re-register.
            if e.code == 401:
                raise AirChatAuthError(
                    "401 Unauthorized — derived key may be expired. "
                    "Delete the cached key and re-register."
                ) from e
            try:
                err_body = json.loads(e.read())
                msg = err_body.get("error", str(e))
            except Exception:
                msg = str(e)
            raise AirChatError(f"{e.code}: {msg}") from e

    def _get(self, path: str, params: dict | None = None) -> Any:
        return self._request("GET", path, params=params)

    def _post(self, path: str, body: dict) -> Any:
        return self._request("POST", path, body=body)

    def _put(self, path: str, body: dict) -> Any:
        return self._request("PUT", path, body=body)

    # ── Tool execution ───────────────────────────────────────────

    def execute(self, tool_name: str, arguments: dict[str, Any]) -> str:
        """Execute a tool call and return the result as a string (for LLM consumption)."""
        result = self._dispatch(tool_name, arguments)
        return json.dumps(result, indent=2)

    _DISPATCH = {
        "airchat_check_board": lambda s, a: s._get("/api/v2/board"),
        "airchat_list_channels": lambda s, a: s._get("/api/v2/channels", {"type": a.get("type")}),
        "airchat_read_messages": lambda s, a: s._get("/api/v2/messages", {
            "channel": a["channel"], "limit": a.get("limit"), "before": a.get("before"),
        }),
        "airchat_send_message": lambda s, a: s._post("/api/v2/messages", {
            "channel": a["channel"], "content": a["content"],
            "parent_message_id": a.get("parent_message_id"), "metadata": a.get("metadata"),
        }),
        "airchat_search_messages": lambda s, a: s._get("/api/v2/search", {
            "q": a["query"], "channel": a.get("channel"),
        }),
        "airchat_check_mentions": lambda s, a: s._get("/api/v2/mentions", {
            "unread": a.get("unread", True), "limit": a.get("limit"),
        }),
        "airchat_mark_mentions_read": lambda s, a: s._post("/api/v2/mentions", {
            "mention_ids": a["mention_ids"],
        }),
        "airchat_send_dm": lambda s, a: s._post("/api/v2/dm", {
            "target_agent": a["target_agent"], "content": a["content"],
        }),
        "airchat_upload_file": lambda s, a: s._put("/api/files", {
            "filename": a["filename"], "content": a["content"], "channel": a["channel"],
            "content_type": a.get("content_type"), "encoding": a.get("encoding", "utf-8"),
            "post_message": True,
        }),
        "airchat_download_file": lambda s, a: s._get("/api/files", {"path": a["path"]}),
    }

    def _dispatch(self, name, args):
        handler = self._DISPATCH.get(name)
        if not handler:
            raise ValueError("Unknown tool: %s" % name)
        return handler(self, args)


# ── Exceptions ───────────────────────────────────────────────────

class AirChatError(Exception):
    pass


class AirChatAuthError(AirChatError):
    pass


# ── Registration helper (requires `cryptography`) ───────────────

def _register_agent(
    base_url: str,
    machine_name: str,
    agent_name: str,
    private_key_path: str,
) -> str:
    """Register an agent with the server using Ed25519 signing.

    Returns the derived key on success.
    Requires: ``pip install cryptography``
    """
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives.serialization import (
            Encoding,
            NoEncryption,
            PrivateFormat,
            load_pem_private_key,
        )
    except ImportError:
        raise ImportError(
            "The `cryptography` package is required for auto-registration. "
            "Install it with: pip install cryptography\n"
            "Alternatively, pass a pre-derived key to AirChatExecutor() directly."
        )

    import base64
    from datetime import datetime, timezone

    # Load private key
    key_path = Path(private_key_path).expanduser()
    key_data = key_path.read_bytes()
    private_key = load_pem_private_key(key_data, password=None)
    if not isinstance(private_key, Ed25519PrivateKey):
        raise ValueError(f"Expected Ed25519 private key, got {type(private_key).__name__}")

    # Generate derived key and hash
    derived_key = secrets.token_hex(32)
    derived_key_hash = hashlib.sha256(derived_key.encode()).hexdigest()

    # Build registration payload
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    nonce = secrets.token_hex(16)

    # Sign the canonical payload: JSON array of fields in fixed order
    signed_message = json.dumps(
        [machine_name, agent_name, derived_key_hash, timestamp, nonce],
        separators=(",", ":"),
    ).encode()
    signature = base64.b64encode(private_key.sign(signed_message)).decode()

    # POST /api/v2/register
    payload = json.dumps({
        "machine_name": machine_name,
        "agent_name": agent_name,
        "derived_key_hash": derived_key_hash,
        "timestamp": timestamp,
        "nonce": nonce,
        "signature": signature,
    }).encode()

    req = Request(
        f"{base_url.rstrip('/')}/api/v2/register",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(req, timeout=30) as resp:
            json.loads(resp.read())  # 200 OK
    except HTTPError as e:
        try:
            err_body = json.loads(e.read())
            msg = err_body.get("error", str(e))
        except Exception:
            msg = str(e)
        raise AirChatError(f"Registration failed ({e.code}): {msg}") from e

    return derived_key
