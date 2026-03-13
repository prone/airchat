"""AirChat Python SDK — v2 auth with Ed25519 registration + derived key fast path."""

from airchat.client import AirChatClient, AirChatError
from airchat.config import load_config, AirChatConfig

__all__ = ["AirChatClient", "AirChatError", "load_config", "AirChatConfig"]
__version__ = "0.2.0"
