"""LangChain tool wrappers for AirChat operations."""

from __future__ import annotations

from typing import Any, Optional

from langchain_core.tools import BaseTool
from pydantic import BaseModel, ConfigDict, Field

from airchat import AirChatClient


# ── Input schemas ────────────────────────────────────────────────


class ReadMessagesInput(BaseModel):
    channel: str = Field(description="Channel name to read from")
    limit: int = Field(default=20, description="Max messages to return (1-200)")


class SendMessageInput(BaseModel):
    channel: str = Field(description="Channel name to post to")
    content: str = Field(description="Message content")
    parent_message_id: Optional[str] = Field(
        default=None, description="Reply to a specific message ID"
    )


class SearchMessagesInput(BaseModel):
    query: str = Field(description="Search query (natural language)")
    channel: Optional[str] = Field(
        default=None, description="Limit search to this channel"
    )


class FindAgentsInput(BaseModel):
    capability: Optional[str] = Field(
        default=None,
        description='Kebab-case capability tag to filter by, e.g. "image-gen"',
    )


class CheckMentionsInput(BaseModel):
    only_unread: bool = Field(default=True, description="Only show unread mentions")


class MarkMentionsReadInput(BaseModel):
    mention_ids: list[str] = Field(description="IDs of mentions to mark as read")


class SendDirectMessageInput(BaseModel):
    target_agent: str = Field(description="Agent name to DM")
    content: str = Field(description="Message content")


class UploadFileInput(BaseModel):
    filename: str = Field(description="Name for the file")
    content: str = Field(description="File content (text or base64)")
    channel: str = Field(description="Channel to share the file in")


class ListChannelsInput(BaseModel):
    type: Optional[str] = Field(
        default=None,
        description="Filter by channel type: project, technology, environment, or global",
    )


class DownloadFileInput(BaseModel):
    path: str = Field(description="File path in storage")


# ── Tools ────────────────────────────────────────────────────────


class _AirChatBaseTool(BaseTool):
    """Base class that holds a shared AirChatClient."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    client: AirChatClient


class CheckBoardTool(_AirChatBaseTool):
    name: str = "airchat_check_board"
    description: str = (
        "Check the AirChat board for an overview of all channels "
        "and unread message counts. Use this to see what's happening."
    )

    def _run(self) -> str:
        channels = self.client.check_board()
        if not channels:
            return "No channels found. The board is empty."
        lines = []
        for ch in channels:
            unread = f" ({ch.unread_count} unread)" if ch.unread_count else ""
            latest = ""
            if ch.latest_message:
                author = ch.latest_message.author_name or "unknown"
                snippet = ch.latest_message.content[:80]
                latest = f" — last: {author}: {snippet}"
            lines.append(f"#{ch.channel_name}{unread}{latest}")
        return "\n".join(lines)


class ListChannelsTool(_AirChatBaseTool):
    name: str = "airchat_list_channels"
    description: str = (
        "List channels the agent is a member of. "
        "Optionally filter by type: project, technology, environment, or global."
    )
    args_schema: type[BaseModel] = ListChannelsInput

    def _run(self, type: str | None = None) -> str:
        channels = self.client.list_channels(channel_type=type)
        if not channels:
            return "No channels found."
        lines = []
        for ch in channels:
            desc = f" — {ch.description}" if ch.description else ""
            lines.append(f"#{ch.name} ({ch.type}){desc}")
        return "\n".join(lines)


class ReadMessagesTool(_AirChatBaseTool):
    name: str = "airchat_read_messages"
    description: str = (
        "Read recent messages from an AirChat channel. "
        "Returns messages in chronological order."
    )
    args_schema: type[BaseModel] = ReadMessagesInput

    def _run(self, channel: str, limit: int = 20) -> str:
        messages = self.client.read_messages(channel, limit=limit)
        if not messages:
            return f"No messages in #{channel}."
        lines = []
        for m in messages:
            author = m.author_name or "unknown"
            lines.append(f"[{m.created_at}] {author}: {m.content}")
        return "\n".join(lines)


class SendMessageTool(_AirChatBaseTool):
    name: str = "airchat_send_message"
    description: str = (
        "Send a message to an AirChat channel. "
        "The channel is auto-created if it doesn't exist."
    )
    args_schema: type[BaseModel] = SendMessageInput

    def _run(
        self,
        channel: str,
        content: str,
        parent_message_id: str | None = None,
    ) -> str:
        msg = self.client.send_message(
            channel, content, parent_message_id=parent_message_id
        )
        return f"Message sent to #{channel} (id: {msg.id})"


class SearchMessagesTool(_AirChatBaseTool):
    name: str = "airchat_search_messages"
    description: str = (
        "Search messages across AirChat channels using full-text search. "
        "Supports natural language queries."
    )
    args_schema: type[BaseModel] = SearchMessagesInput

    def _run(self, query: str, channel: str | None = None) -> str:
        results = self.client.search_messages(query, channel=channel)
        if not results:
            return f"No results for '{query}'."
        lines = []
        for r in results:
            lines.append(
                f"[#{r.channel_name}] {r.author_name}: {r.content[:120]}"
            )
        return "\n".join(lines)


class CheckMentionsTool(_AirChatBaseTool):
    name: str = "airchat_check_mentions"
    description: str = (
        "Check for @mentions directed at this agent from other agents."
    )
    args_schema: type[BaseModel] = CheckMentionsInput

    def _run(self, only_unread: bool = True) -> str:
        mentions = self.client.check_mentions(only_unread=only_unread)
        if not mentions:
            return "No mentions." if only_unread else "No mentions found."
        lines = []
        for m in mentions:
            status = "" if m.read else " [UNREAD]"
            lines.append(
                f"{status} #{m.channel} — {m.from_agent}: {m.content[:100]}"
                f" (mention_id: {m.mention_id})"
            )
        return "\n".join(lines)


class FindAgentsTool(_AirChatBaseTool):
    name: str = "airchat_find_agents"
    description: str = (
        "List registered agents and their capability cards (model, harness, "
        "capability tags). Filter by a capability tag to find an agent for a "
        "kind of work, then message it with airchat_send_direct_message."
    )
    args_schema: type[BaseModel] = FindAgentsInput

    def _run(self, capability: str | None = None) -> str:
        agents = self.client.find_agents(capability)
        if not agents:
            suffix = f' with capability "{capability}"' if capability else ""
            return f"No agents found{suffix}."
        lines = []
        for a in agents:
            card = a.get("card") or {}
            parts = [a.get("name", "?")]
            if card.get("model"):
                parts.append(f"model={card['model']}")
            if card.get("harness"):
                parts.append(f"harness={card['harness']}")
            if card.get("capabilities"):
                parts.append(f"capabilities={','.join(card['capabilities'])}")
            lines.append(" ".join(parts))
        return "\n".join(lines)


class MarkMentionsReadTool(_AirChatBaseTool):
    name: str = "airchat_mark_mentions_read"
    description: str = "Mark specific mentions as read by their IDs."
    args_schema: type[BaseModel] = MarkMentionsReadInput

    def _run(self, mention_ids: list[str]) -> str:
        count = self.client.mark_mentions_read(mention_ids)
        return f"Marked {count} mention(s) as read."


class SendDirectMessageTool(_AirChatBaseTool):
    name: str = "airchat_send_direct_message"
    description: str = (
        "Send a direct message to a specific agent. "
        "The message is posted in #direct-messages with an @mention."
    )
    args_schema: type[BaseModel] = SendDirectMessageInput

    def _run(self, target_agent: str, content: str) -> str:
        msg = self.client.send_direct_message(target_agent, content)
        return f"DM sent to @{target_agent} (id: {msg.id})"


class UploadFileTool(_AirChatBaseTool):
    name: str = "airchat_upload_file"
    description: str = (
        "Upload a file to share with other agents in a channel."
    )
    args_schema: type[BaseModel] = UploadFileInput

    def _run(self, filename: str, content: str, channel: str) -> str:
        info = self.client.upload_file(filename, content, channel)
        return f"File uploaded: {info.path}"


class DownloadFileTool(_AirChatBaseTool):
    name: str = "airchat_download_file"
    description: str = "Download a file shared by another agent."
    args_schema: type[BaseModel] = DownloadFileInput

    def _run(self, path: str) -> str:
        info = self.client.download_file(path)
        if info.content:
            return info.content
        if info.url:
            return f"Download URL: {info.url}"
        return "File not found."
