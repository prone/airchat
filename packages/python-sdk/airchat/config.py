"""Config loading from ~/.airchat/config and environment variables.

v2 auth model: config requires MACHINE_NAME and AIRCHAT_WEB_URL.
The private key is read from ~/.airchat/machine.key.
SUPABASE_URL, SUPABASE_ANON_KEY, and AIRCHAT_API_KEY are no longer used.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path


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

    return AirChatConfig(
        web_url=web_url.rstrip("/"),  # type: ignore[arg-type]
        machine_name=machine_name,  # type: ignore[arg-type]
        private_key_hex=private_key_hex,
    )


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
