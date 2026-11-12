"""wait_for_work: block until a mention is waiting, without missing one."""

import pytest

from airchat import client as client_module
from airchat.client import AirChatClient, AirChatError


class Clock:
    """Stands in for time: sleeping moves it forward, nothing really waits."""

    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class Server:
    """Answers the two requests wait_for_work makes, from scripted lists."""

    def __init__(self, clock, work, waits):
        self.clock = clock
        self.work = list(work)
        self.waits = list(waits)
        self.calls = []

    def request(self, method, path, *, params=None, body=None, timeout=30, _retried=False):
        self.calls.append((path, dict(params or {})))
        if path == "/api/v2/work":
            return self.work.pop(0) if len(self.work) > 1 else self.work[0]
        assert path == "/api/v2/work/wait"
        answer = self.waits.pop(0) if len(self.waits) > 1 else self.waits[0]
        if isinstance(answer, Exception):
            raise answer
        if params and "after" in params and "took" in answer:
            self.clock.now += answer["took"]  # answered after this long, whatever was asked
        elif params and "after" in params and not answer.get("changed"):
            self.clock.now += params["timeout"]  # held open until its timeout
        return answer

    def paths(self):
        return [path for path, _ in self.calls]


NOTHING = {"mentions": [], "open_matching": []}
MENTION = {"mentions": [{"mention_id": "m1"}], "open_matching": []}
TASK = {"mentions": [], "open_matching": [{"id": "t1"}]}


@pytest.fixture
def make(monkeypatch):
    def build(work, waits):
        clock = Clock()
        monkeypatch.setattr(client_module.time, "monotonic", clock.monotonic)
        monkeypatch.setattr(client_module.time, "sleep", clock.sleep)
        agent = AirChatClient.__new__(AirChatClient)
        server = Server(clock, work, waits)
        agent._request = server.request
        return agent, server, clock

    return build


def test_returns_at_once_when_a_mention_is_already_waiting(make):
    agent, server, _ = make([MENTION], [{"changed": False, "cursor": "c1"}])
    assert agent.wait_for_work() == MENTION
    # The cursor is asked for before the read, never after it.
    assert server.paths() == ["/api/v2/work/wait", "/api/v2/work"]


def test_waits_with_the_cursor_then_reads_when_told_something_changed(make):
    agent, server, _ = make(
        [NOTHING, MENTION],
        [{"changed": False, "cursor": "c1"}, {"changed": True, "dm": True, "cursor": "c2"}],
    )
    assert agent.wait_for_work() == MENTION
    assert server.calls[2] == ("/api/v2/work/wait", {"after": "c1", "timeout": 25})
    assert server.paths()[-1] == "/api/v2/work"


def test_gives_up_after_the_timeout(make):
    agent, server, clock = make([NOTHING], [{"changed": False, "cursor": "c1"}])
    assert agent.wait_for_work(timeout=60) is None
    assert 60 <= clock.now < 75
    # The last wait is shortened to the time that was left.
    waits = [params["timeout"] for path, params in server.calls if "after" in params]
    assert waits == [25, 25, 10]


def test_a_zero_timeout_is_one_look(make):
    agent, server, _ = make([NOTHING], [{"changed": False, "cursor": "c1"}])
    assert agent.wait_for_work(timeout=0) is None
    assert server.paths().count("/api/v2/work") == 1


def test_ignores_open_tasks_unless_asked(make):
    agent, _, _ = make([TASK], [{"changed": False, "cursor": "c1"}])
    assert agent.wait_for_work(timeout=30) is None
    agent, _, _ = make([TASK], [{"changed": False, "cursor": "c1"}])
    assert agent.wait_for_work(timeout=30, include_tasks=True) == TASK


def test_with_tasks_it_rereads_at_least_every_poll_interval(make):
    agent, server, _ = make([NOTHING, NOTHING, TASK], [{"changed": False, "cursor": "c1"}])
    assert agent.wait_for_work(include_tasks=True, poll_interval=10) == TASK
    assert [p["timeout"] for _, p in server.calls if "after" in p] == [10, 10]


@pytest.mark.parametrize("status", [404, 503])
def test_polls_when_the_server_cannot_hold_a_wait(make, status):
    agent, server, clock = make([NOTHING, NOTHING, MENTION], [AirChatError("off", status=status)])
    assert agent.wait_for_work(poll_interval=20) == MENTION
    assert clock.sleeps == [20, 20]
    # It asked once, then stopped asking.
    assert server.paths().count("/api/v2/work/wait") == 1


def test_honours_the_wait_the_server_asks_for_when_rate_limited(make):
    agent, _, clock = make(
        [NOTHING, MENTION],
        [
            {"changed": False, "cursor": "c1"},
            AirChatError("slow down", status=429, retry_after=7),
            {"changed": False, "cursor": "c2"},
        ],
    )
    assert agent.wait_for_work() == MENTION
    assert clock.sleeps == [7]


def test_starts_again_after_a_dropped_connection(make):
    agent, server, clock = make(
        [NOTHING, MENTION],
        [{"changed": False, "cursor": "c1"}, TimeoutError("timed out"), {"changed": False, "cursor": "c2"}],
    )
    assert agent.wait_for_work() == MENTION
    assert clock.sleeps == [5]
    # A new cursor is taken before the re-read.
    assert server.paths()[-2:] == ["/api/v2/work/wait", "/api/v2/work"]


def test_a_too_busy_server_is_retried_later_not_abandoned(make):
    agent, server, clock = make(
        [NOTHING, NOTHING, MENTION],
        [
            {"changed": False, "cursor": "c1"},
            AirChatError("too many waiting", status=503, retry_after=60),
            {"changed": False, "cursor": "c2"},
            {"changed": True, "cursor": "c3"},
        ],
    )
    assert agent.wait_for_work() == MENTION
    assert clock.sleeps == [60]
    assert server.paths().count("/api/v2/work/wait") == 4


def test_pauses_longer_each_time_a_wait_is_answered_at_once(make):
    # "changed" makes the scripted server answer without time passing, as a
    # broken server or proxy would. The loop must not ask in a tight loop.
    agent, server, clock = make([NOTHING], [{"cursor": "c1"}, {"changed": True, "cursor": "c1"}])
    assert agent.wait_for_work(timeout=120) is None
    assert clock.sleeps[:7] == [1, 2, 4, 8, 16, 30, 30]
    assert len([p for p, params in server.calls if "after" in params]) < 12


def test_not_kept_busy_by_a_server_answering_just_past_a_second(make):
    # A fixed one-second line between "held" and "not held" would count each
    # of these as held, and the loop would ask again at once, for ever.
    agent, server, clock = make([NOTHING], [{"cursor": "c1"}, {"cursor": "c1", "took": 1.1}])
    assert agent.wait_for_work(timeout=600) is None
    assert clock.sleeps[:6] == [1, 2, 4, 8, 16, 30]
    assert len([p for p, params in server.calls if "after" in params]) < 30


def test_a_wait_held_for_most_of_its_time_counts_as_held(make):
    agent, _, clock = make([NOTHING], [{"cursor": "c1"}, {"cursor": "c1", "took": 15}])
    assert agent.wait_for_work(timeout=60) is None
    assert clock.sleeps == []


def test_no_pause_when_the_quick_answer_brought_a_mention(make):
    agent, _, clock = make([NOTHING, MENTION], [{"cursor": "c1"}, {"changed": True, "cursor": "c2"}])
    assert agent.wait_for_work() == MENTION
    assert clock.sleeps == []


@pytest.mark.parametrize(
    "header, seconds",
    [("3000000", 300), ("0.001", 1), ("42", 42), ("-5", None), ("soon", None), ("inf", None), ("nan", None), (None, None)],
)
def test_retry_after_is_kept_within_reason(header, seconds):
    assert client_module._retry_after(header) == seconds
