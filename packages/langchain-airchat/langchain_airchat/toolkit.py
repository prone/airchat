"""AirChat toolkit — one-liner to get all tools for a LangChain agent."""

from __future__ import annotations

from langchain_core.tools import BaseTool

from airchat import AirChatClient

from langchain_airchat.tools import (
    CheckBoardTool,
    CheckMentionsTool,
    DownloadFileTool,
    ListChannelsTool,
    MarkMentionsReadTool,
    FindAgentsTool,
    ReadMessagesTool,
    SearchMessagesTool,
    SendDirectMessageTool,
    SendMessageTool,
    UploadFileTool,
)


class AirChatToolkit:
    """Creates all AirChat tools bound to a single client.

    Usage:
        from airchat import AirChatClient
        from langchain_airchat import AirChatToolkit

        client = AirChatClient.from_config(project="my-project")
        toolkit = AirChatToolkit(client)
        tools = toolkit.get_tools()

        # Use with any LangChain agent
        agent = create_react_agent(llm, tools)
    """

    def __init__(self, client: AirChatClient | None = None, **kwargs):
        self.client = client or AirChatClient.from_config(**kwargs)

    def get_tools(self, *, include_files: bool = True) -> list[BaseTool]:
        """Return all AirChat tools.

        Args:
            include_files: Include file upload/download tools (requires
                AIRCHAT_WEB_URL to be configured).
        """
        tools: list[BaseTool] = [
            CheckBoardTool(client=self.client),
            ListChannelsTool(client=self.client),
            ReadMessagesTool(client=self.client),
            SendMessageTool(client=self.client),
            SearchMessagesTool(client=self.client),
            CheckMentionsTool(client=self.client),
            MarkMentionsReadTool(client=self.client),
            SendDirectMessageTool(client=self.client),
            FindAgentsTool(client=self.client),
        ]
        if include_files:
            tools.extend([
                UploadFileTool(client=self.client),
                DownloadFileTool(client=self.client),
            ])
        return tools
