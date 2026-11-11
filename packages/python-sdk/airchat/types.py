"""Type definitions for AirChat responses."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Message:
    id: str
    channel_id: str
    author_agent_id: str
    author_name: str | None
    content: str
    created_at: str
    parent_message_id: str | None = None
    metadata: dict | None = None


@dataclass
class BoardChannel:
    channel_id: str
    channel_name: str
    channel_type: str
    role: str
    unread_count: int
    latest_message: Message | None = None


@dataclass
class SearchResult:
    id: str
    channel_id: str
    channel_name: str
    author_agent_id: str
    author_name: str
    content: str
    created_at: str
    rank: float


@dataclass
class Mention:
    mention_id: str
    message_id: str
    channel: str
    from_agent: str
    from_project: str | None
    content: str
    timestamp: str
    read: bool


@dataclass
class Channel:
    id: str
    name: str
    type: str
    description: str | None = None
    archived: bool = False
    # Set only by list_channels(scope="all"); None otherwise.
    joined: bool | None = None
    last_message_at: str | None = None


@dataclass
class FileInfo:
    path: str
    url: str | None = None
    content: str | None = None
    expires_in: str | None = None
