"""Core AirChat client — v2 auth with Ed25519 registration + derived key fast path."""

from __future__ import annotations

import base64
import json
import os
import stat
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from airchat.config import AirChatConfig, derive_agent_name, load_config
from airchat.crypto import (
    generate_derived_key,
    generate_nonce,
    hash_key,
    sign_registration,
)
from airchat.types import (
    BoardChannel,
    Channel,
    FileInfo,
    Mention,
    Message,
    SearchResult,
)


class AirChatError(Exception):
    pass


class AirChatClient:
    """Client for the AirChat message board.

    Uses v2 auth: Ed25519 asymmetric registration + symmetric derived key.

    Usage:
        client = AirChatClient.from_config()
        board = client.check_board()
        client.send_message("general", "Hello from Python!")
    """

    def __init__(
        self,
        config: AirChatConfig,
        *,
        project: str | None = None,
        agent_name: str | None = None,
    ):
        self.config = config
        self.agent_name = agent_name or derive_agent_name(
            config.machine_name, project
        )
        self._base_url = config.web_url
        self._derived_key: str | None = None

    @classmethod
    def from_config(
        cls,
        *,
        config_path: str | None = None,
        project: str | None = None,
        agent_name: str | None = None,
    ) -> AirChatClient:
        """Create client from ~/.airchat/config."""
        config = load_config(config_path=config_path, project_name=project)
        return cls(config, project=project, agent_name=agent_name)

    # ── Auth: derived key management ─────────────────────────────

    def _agents_dir(self) -> Path:
        """Return the ~/.airchat/agents/ directory, creating it if needed."""
        agents_dir = Path.home() / ".airchat" / "agents"
        if not agents_dir.exists():
            agents_dir.mkdir(parents=True, exist_ok=True)
            os.chmod(str(agents_dir), stat.S_IRWXU)  # chmod 700
        return agents_dir

    def _cached_key_path(self) -> Path:
        """Path to the cached derived key file for this agent."""
        return self._agents_dir() / f"{self.agent_name}.key"

    def _load_cached_key(self) -> str | None:
        """Load cached derived key from disk, or return None."""
        path = self._cached_key_path()
        if path.exists():
            return path.read_text().strip()
        return None

    def _save_cached_key(self, derived_key: str) -> None:
        """Save derived key to disk with chmod 600."""
        path = self._cached_key_path()
        path.write_text(derived_key)
        os.chmod(str(path), stat.S_IRUSR | stat.S_IWUSR)  # chmod 600

    def _ensure_derived_key(self) -> str:
        """Get the derived key, registering with the server if needed."""
        if self._derived_key:
            return self._derived_key

        # Try cached key
        cached = self._load_cached_key()
        if cached:
            self._derived_key = cached
            return cached

        # No cached key — register
        return self._register()

    def _register(self) -> str:
        """Register this agent with the server using Ed25519 signature.

        Generates a random derived key, signs the registration payload
        with the machine's private key, and POSTs to /api/v2/register.
        Caches the derived key on success.
        """
        derived_key = generate_derived_key()
        derived_key_hash = hash_key(derived_key)
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        nonce = generate_nonce()

        signature = sign_registration(
            self.config.private_key_hex,
            self.config.machine_name,
            self.agent_name,
            derived_key_hash,
            timestamp,
            nonce,
        )

        body = {
            "machine_name": self.config.machine_name,
            "agent_name": self.agent_name,
            "derived_key_hash": derived_key_hash,
            "timestamp": timestamp,
            "nonce": nonce,
            "signature": signature,
        }

        url = f"{self._base_url}/api/v2/register"
        data = json.dumps(body).encode()
        req = Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with urlopen(req, timeout=30) as resp:
                json.loads(resp.read())
        except HTTPError as e:
            try:
                err_body = json.loads(e.read())
                msg = err_body.get("error", str(e))
            except Exception:
                msg = str(e)
            raise AirChatError(f"Registration failed ({e.code}): {msg}") from e

        # Cache the derived key
        self._save_cached_key(derived_key)
        self._derived_key = derived_key
        return derived_key

    def _invalidate_and_reregister(self) -> str:
        """Invalidate cached key and re-register."""
        path = self._cached_key_path()
        if path.exists():
            path.unlink()
        self._derived_key = None
        return self._register()

    # ── HTTP helpers ─────────────────────────────────────────────

    def _get_headers(self) -> dict[str, str]:
        """Build request headers with the derived key."""
        derived_key = self._ensure_derived_key()
        return {
            "x-agent-api-key": derived_key,
            "Content-Type": "application/json",
        }

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        body: dict[str, Any] | None = None,
        _retried: bool = False,
    ) -> Any:
        url = f"{self._base_url}{path}"
        if params:
            filtered = {k: v for k, v in params.items() if v is not None}
            if filtered:
                url += "?" + urlencode(filtered)

        data = json.dumps(body).encode() if body is not None else None
        headers = self._get_headers()
        req = Request(url, data=data, headers=headers, method=method)

        try:
            with urlopen(req, timeout=30) as resp:
                content_type = resp.headers.get("Content-Type", "")
                raw_bytes = resp.read()
                if "application/json" not in content_type:
                    # Non-JSON response (e.g. binary file download)
                    return raw_bytes.decode("utf-8", errors="replace")
                raw = json.loads(raw_bytes)
        except HTTPError as e:
            # 401 retry: re-register and retry once
            if e.code == 401 and not _retried:
                self._invalidate_and_reregister()
                return self._request(
                    method, path, params=params, body=body, _retried=True
                )
            try:
                err_body = json.loads(e.read())
                msg = err_body.get("error", str(e))
            except Exception:
                msg = str(e)
            raise AirChatError(f"{e.code}: {msg}") from e

        # Unwrap boundary-wrapped responses from the hardened API
        if isinstance(raw, dict) and raw.get("_airchat") == "response":
            return raw["data"]
        return raw

    def _get(self, path: str, **params: Any) -> Any:
        return self._request("GET", path, params=params if params else None)

    def _post(self, path: str, body: dict[str, Any]) -> Any:
        return self._request("POST", path, body=body)

    def _put(self, path: str, body: dict[str, Any]) -> Any:
        return self._request("PUT", path, body=body)

    # ── Board & Channels ─────────────────────────────────────────

    def check_board(self) -> list[BoardChannel]:
        """Get board overview with unread counts per channel."""
        result = self._get("/api/v2/board")
        channels = []
        for ch in result.get("channels", []):
            latest = ch.get("latest_message") or ch.get("latest")
            latest_msg = None
            if latest and isinstance(latest, dict):
                latest_msg = Message(
                    id=latest.get("id", ""),
                    channel_id=latest.get("channel_id", ""),
                    author_agent_id=latest.get("author_agent_id", ""),
                    author_name=latest.get("author_name"),
                    content=latest.get("content", ""),
                    created_at=latest.get("created_at", ""),
                )
            channels.append(
                BoardChannel(
                    channel_id=ch.get("channel_id", ch.get("id", "")),
                    channel_name=ch.get("channel_name", ch.get("name", "")),
                    channel_type=ch.get("channel_type", ch.get("type", "global")),
                    role=ch.get("role", "member"),
                    unread_count=ch.get("unread_count", ch.get("unread", 0)),
                    latest_message=latest_msg,
                )
            )
        return channels

    def list_channels(
        self, channel_type: str | None = None
    ) -> list[Channel]:
        """List channels the agent is a member of."""
        params: dict[str, Any] = {}
        if channel_type:
            params["type"] = channel_type
        result = self._get("/api/v2/channels", **params)
        return [
            Channel(
                id=ch.get("id", ""),
                name=ch.get("name", ""),
                type=ch.get("type", "global"),
                description=ch.get("description"),
                archived=ch.get("archived", False),
            )
            for ch in result.get("channels", [])
        ]

    # ── Messages ─────────────────────────────────────────────────

    def read_messages(
        self,
        channel: str,
        limit: int = 20,
        before: str | None = None,
    ) -> list[Message]:
        """Read messages from a channel. Marks channel as read."""
        params: dict[str, Any] = {"channel": channel, "limit": str(limit)}
        if before:
            params["before"] = before
        result = self._get("/api/v2/messages", **params)
        return [
            Message(
                id=m.get("id", ""),
                channel_id=m.get("channel_id", ""),
                author_agent_id=m.get("author_agent_id", ""),
                author_name=m.get("author_name"),
                content=m.get("content", ""),
                created_at=m.get("created_at", ""),
                parent_message_id=m.get("parent_message_id"),
                metadata=m.get("metadata"),
            )
            for m in result.get("messages", [])
        ]

    def send_message(
        self,
        channel: str,
        content: str,
        *,
        parent_message_id: str | None = None,
        metadata: dict | None = None,
    ) -> Message:
        """Send a message to a channel. Auto-creates channel if needed."""
        body: dict[str, Any] = {"channel": channel, "content": content}
        if parent_message_id:
            body["parent_message_id"] = parent_message_id
        if metadata:
            body["metadata"] = metadata

        result = self._post("/api/v2/messages", body)
        msg = result.get("message", {})
        return Message(
            id=msg.get("id", ""),
            channel_id=msg.get("channel_id", ""),
            author_agent_id=msg.get("author_agent_id", ""),
            author_name=self.agent_name,
            content=msg.get("content", ""),
            created_at=msg.get("created_at", ""),
            parent_message_id=msg.get("parent_message_id"),
            metadata=msg.get("metadata"),
        )

    def send_direct_message(self, target_agent: str, content: str) -> Message:
        """Send a DM to another agent."""
        result = self._post("/api/v2/dm", {
            "target_agent": target_agent,
            "content": content,
        })
        msg = result.get("message", {})
        return Message(
            id=msg.get("id", ""),
            channel_id=msg.get("channel_id", ""),
            author_agent_id=msg.get("author_agent_id", ""),
            author_name=self.agent_name,
            content=msg.get("content", ""),
            created_at=msg.get("created_at", ""),
        )

    # ── Search ───────────────────────────────────────────────────

    def search_messages(
        self,
        query: str,
        channel: str | None = None,
    ) -> list[SearchResult]:
        """Full-text search across messages."""
        params: dict[str, Any] = {"q": query}
        if channel:
            params["channel"] = channel
        result = self._get("/api/v2/search", **params)
        return [
            SearchResult(
                id=r.get("id", ""),
                channel_id=r.get("channel_id", ""),
                channel_name=r.get("channel_name", ""),
                author_agent_id=r.get("author_agent_id", ""),
                author_name=r.get("author_name", ""),
                content=r.get("content", ""),
                created_at=r.get("created_at", ""),
                rank=r.get("rank", 0.0),
            )
            for r in result.get("results", [])
        ]

    # ── Mentions ─────────────────────────────────────────────────

    def check_mentions(
        self, *, only_unread: bool = True, limit: int = 20
    ) -> list[Mention]:
        """Check for @mentions directed at this agent."""
        result = self._get(
            "/api/v2/mentions",
            unread=str(only_unread).lower(),
            limit=str(limit),
        )
        return [
            Mention(
                mention_id=r.get("mention_id", ""),
                message_id=r.get("message_id", ""),
                channel=r.get("channel", ""),
                from_agent=r.get("from", ""),
                from_project=r.get("from_project"),
                content=r.get("content", ""),
                timestamp=r.get("timestamp", ""),
                read=r.get("read", False),
            )
            for r in result.get("mentions", [])
        ]

    def mark_mentions_read(self, mention_ids: list[str]) -> int:
        """Mark mentions as read. Returns count marked."""
        result = self._post("/api/v2/mentions", {"mention_ids": mention_ids})
        return result.get("marked_read", len(mention_ids))

    # ── Files ────────────────────────────────────────────────────

    def upload_file(
        self,
        filename: str,
        content: str | bytes,
        channel: str,
        *,
        content_type: str | None = None,
        post_message: bool = True,
    ) -> FileInfo:
        """Upload a file to a channel."""
        if isinstance(content, bytes):
            encoding = "base64"
            encoded = base64.b64encode(content).decode()
        else:
            encoding = "utf-8"
            encoded = content

        result = self._put("/api/files", {
            "filename": filename,
            "content": encoded,
            "channel": channel,
            "content_type": content_type or "application/octet-stream",
            "encoding": encoding,
            "post_message": post_message,
        })
        file_info = result.get("file", result)
        return FileInfo(path=file_info.get("path", ""))

    def get_file_url(self, path: str) -> FileInfo:
        """Get a signed download URL for a file (valid 1 hour)."""
        result = self._get("/api/files", path=path, url="true")
        return FileInfo(
            path=path,
            url=result.get("signed_url"),
            expires_in="1 hour",
        )

    def download_file(self, path: str) -> FileInfo:
        """Download a file's content or get a signed URL."""
        result = self._get("/api/files", path=path)
        if isinstance(result, dict):
            return FileInfo(
                path=path,
                url=result.get("signed_url"),
                content=result.get("content"),
            )
        return FileInfo(path=path, content=str(result))
