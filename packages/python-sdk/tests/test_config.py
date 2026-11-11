"""The warning for a server URL that sends the agent key unencrypted.

The key travels in a header on every request. Over http to a public host it
can be read in transit, so loading the config says so. It does not refuse:
http is the normal setup on a tailnet or a LAN.
"""

import pytest

from airchat import config
from airchat.config import is_plaintext_public_url, warn_if_plaintext_public_url


@pytest.fixture(autouse=True)
def _forget_warnings():
    config._warned_urls.clear()
    yield
    config._warned_urls.clear()


@pytest.mark.parametrize(
    "url",
    [
        "http://airchat.example.com",
        "http://airchat.example.com:3003/",
        "http://93.184.216.34:3003",
        "http://8.8.8.8",
        "http://[2001:4860:4860::8888]:3003",
        "http://172.32.0.1",
        "http://100.128.0.1",
        "http://localhost.example.com",
    ],
)
def test_flags_http_to_a_public_host(url):
    assert is_plaintext_public_url(url) is True


@pytest.mark.parametrize(
    "url",
    [
        "https://airchat.example.com",
        "http://localhost:3003",
        "http://127.0.0.1:3003",
        "http://[::1]:3003",
        "http://10.0.0.5:3003",
        "http://172.16.4.4",
        "http://192.168.1.20:3003",
        "http://169.254.1.1",
        "http://100.64.0.12:3003",
        "http://[fd7a:115c:a1e0::1]:3003",
        "http://nas:3003",
        "http://nas.local:3003",
        "http://nas.tail1234.ts.net:3003",
        "not a url",
    ],
)
def test_accepts_https_loopback_and_private_networks(url):
    assert is_plaintext_public_url(url) is False


def test_warns_once_per_url(capsys):
    assert warn_if_plaintext_public_url("http://airchat.example.com") is True
    assert warn_if_plaintext_public_url("http://airchat.example.com") is False
    err = capsys.readouterr().err
    assert err.count("plain http") == 1
    assert "http://airchat.example.com" in err


def test_stays_silent_for_a_tailnet_address(capsys):
    assert warn_if_plaintext_public_url("http://100.64.0.12:3003") is False
    assert capsys.readouterr().err == ""


def test_load_config_warns_but_still_loads(tmp_path, monkeypatch, capsys):
    (tmp_path / "config").write_text(
        "MACHINE_NAME=macbook\nAIRCHAT_WEB_URL=http://airchat.example.com/\n"
    )
    (tmp_path / "machine.key").write_text("00" * 32)
    monkeypatch.delenv("AIRCHAT_WEB_URL", raising=False)
    monkeypatch.delenv("MACHINE_NAME", raising=False)
    monkeypatch.setattr("airchat.crypto.load_private_key_hex", lambda _path: "00" * 32)

    loaded = config.load_config(config_path=tmp_path / "config")

    assert loaded.web_url == "http://airchat.example.com"
    assert "plain http" in capsys.readouterr().err
