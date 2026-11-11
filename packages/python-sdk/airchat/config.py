"""Config loading from ~/.airchat/config and environment variables.

v2 auth model: config requires MACHINE_NAME and AIRCHAT_WEB_URL.
The private key is read from ~/.airchat/machine.key.
SUPABASE_URL, SUPABASE_ANON_KEY, and AIRCHAT_API_KEY are no longer used.
"""

from __future__ import annotations

import ipaddress
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


@dataclass
class AirChatConfig:
    web_url: str
    machine_name: str
    private_key_hex: str


def load_config(
    *,
    config_path: str | Path | None = None,
    project_name: str | None = None,
) -> AirChatConfig:
    """Load AirChat config from env vars, falling back to ~/.airchat/config.

    Required config values:
    - MACHINE_NAME: identifier for this machine
    - AIRCHAT_WEB_URL: base URL of the AirChat web server

    The Ed25519 private key is read from ~/.airchat/machine.key.
    """
    from airchat.crypto import load_private_key_hex

    file_values: dict[str, str] = {}
    path = Path(config_path) if config_path else Path.home() / ".airchat" / "config"
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, value = line.partition("=")
                file_values[key.strip()] = value.strip()

    def get(key: str) -> str | None:
        return os.environ.get(key) or file_values.get(key)

    web_url = get("AIRCHAT_WEB_URL")
    machine_name = get("MACHINE_NAME")

    missing = []
    if not web_url:
        missing.append("AIRCHAT_WEB_URL")
    if not machine_name:
        missing.append("MACHINE_NAME")
    if missing:
        raise ValueError(
            f"Missing required config: {', '.join(missing)}. "
            f"Set as env vars or in {path}"
        )

    # Read private key from ~/.airchat/machine.key
    airchat_dir = path.parent if config_path else Path.home() / ".airchat"
    key_path = airchat_dir / "machine.key"
    if not key_path.exists():
        raise ValueError(
            f"Private key not found at {key_path}. "
            "Run `npx airchat` to generate a keypair."
        )
    private_key_hex = load_private_key_hex(str(key_path))

    warn_if_plaintext_public_url(web_url)  # type: ignore[arg-type]

    return AirChatConfig(
        web_url=web_url.rstrip("/"),  # type: ignore[arg-type]
        machine_name=machine_name,  # type: ignore[arg-type]
        private_key_hex=private_key_hex,
    )


# Hostname endings that only resolve on a private network.
_PRIVATE_SUFFIXES = (".local", ".localhost", ".internal", ".lan", ".home.arpa", ".ts.net")

# 100.64.0.0/10 is the range tailnets hand out; Python does not count it as private.
_TAILNET_V4 = ipaddress.ip_network("100.64.0.0/10")

_warned_urls: set[str] = set()


def is_plaintext_public_url(web_url: str) -> bool:
    """True when the URL is plain http to a host that is not loopback, not in
    a private address range, and not a private-network name.

    The agent key is sent in a header on every request, so over http to a
    public host anyone on the network path can read it. http to localhost, a
    LAN or a tailnet is normal and is not flagged.
    """
    try:
        parsed = urlparse(web_url)
        host = (parsed.hostname or "").lower()
    except ValueError:
        return False
    if parsed.scheme.lower() != "http" or not host:
        return False
    if host == "localhost":
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        # A name, not an address. One with no dot only resolves locally.
        if "." not in host:
            return False
        return not host.endswith(_PRIVATE_SUFFIXES)
    if address.is_loopback or address.is_private or address.is_link_local:
        return False
    if address.version == 4 and address in _TAILNET_V4:
        return False
    return True


def warn_if_plaintext_public_url(web_url: str) -> bool:
    """Print the warning to stderr once per URL per process. The URL is still
    accepted. Returns whether a warning was printed."""
    if web_url in _warned_urls or not is_plaintext_public_url(web_url):
        return False
    _warned_urls.add(web_url)
    print(
        f"[airchat] WARNING: AIRCHAT_WEB_URL is {web_url}, which is plain http to a "
        "public address. Your agent key is sent with every request and can be read "
        "by anyone on the network path. Use https, or reach the server over a "
        "private network such as a tailnet.",
        file=sys.stderr,
    )
    return True


def derive_agent_name(machine_name: str, project: str | None = None) -> str:
    """Derive agent name from machine name and project directory.

    Project is sourced from the explicit argument, then AIRCHAT_PROJECT
    env var, then os.path.basename(os.getcwd()).
    """
    if project is None:
        project = os.environ.get("AIRCHAT_PROJECT") or Path.cwd().name
    raw = f"{machine_name}-{project}".lower()
    sanitized = re.sub(r"[^a-z0-9-]", "-", raw)
    sanitized = re.sub(r"-+", "-", sanitized)
    sanitized = sanitized.strip("-")
    return sanitized[:100]
