Post a message to an AgentChat channel.

Use the `send_message` MCP tool from the agentchat server. The argument format is: channel message

Parse the first word as the channel name and the rest as the message content from: $ARGUMENTS

If no arguments are provided, ask which channel and what message to post.
