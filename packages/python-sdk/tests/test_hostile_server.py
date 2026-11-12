"""The client against a server, or a proxy in front of one, that misbehaves.

It holds the agent's key and runs unattended, so a bad answer must fail
cleanly: the key goes nowhere else and memory stays bounded.
"""

import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from airchat import client as client_module
from airchat.client import AirChatClient, AirChatError


class Handler(BaseHTTPRequestHandler):
    mode = "ok"
    other = ""
    saw_key = False

    def log_message(self, *args):  # keep test output quiet
        pass

    def do_GET(self):
        cls = type(self)
        if self.server.role == "other":
            if self.headers.get("x-agent-api-key"):
                Handler.saw_key = True
            self._json(b'{"mentions": []}')
        elif cls.mode == "redirect":
            self.send_response(302)
            self.send_header("Location", f"{cls.other}/api/v2/work")
            self.end_headers()
        elif cls.mode == "huge":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            chunk = b"a" * (1024 * 1024)
            try:
                self.wfile.write(b'{"x":"')
                for _ in range(64):
                    self.wfile.write(chunk)
            except OSError:
                pass  # the client stopped reading
        elif cls.mode == "not-json":
            self._json(b"<html>gateway</html>")

    def _json(self, body):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture
def agent():
    servers = []
    for role in ("main", "other"):
        server = HTTPServer(("127.0.0.1", 0), Handler)
        server.role = role
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
    Handler.other = f"http://127.0.0.1:{servers[1].server_port}"
    Handler.saw_key = False
    client = AirChatClient.__new__(AirChatClient)
    client._base_url = f"http://127.0.0.1:{servers[0].server_port}"
    client._get_headers = lambda: {"x-agent-api-key": "cd" * 32}
    yield client
    for server in servers:
        server.shutdown()
        server.server_close()


def test_a_redirect_is_not_followed_and_the_key_is_not_sent_on(agent):
    Handler.mode = "redirect"
    with pytest.raises(AirChatError) as raised:
        agent._request("GET", "/api/v2/work")
    assert raised.value.status == 302
    assert "redirect" in str(raised.value)
    assert Handler.saw_key is False


def test_a_response_past_the_size_limit_is_not_read(agent, monkeypatch):
    Handler.mode = "huge"
    monkeypatch.setattr(client_module, "_MAX_RESPONSE_BYTES", 2 * 1024 * 1024)
    with pytest.raises(AirChatError) as raised:
        agent._request("GET", "/api/v2/work")
    assert "larger than" in str(raised.value)


def test_an_answer_that_is_not_json_is_an_airchat_error(agent):
    Handler.mode = "not-json"
    with pytest.raises(AirChatError):
        agent._request("GET", "/api/v2/work")
