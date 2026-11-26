#!/usr/bin/env python3
"""Smoke test for the persistent-session worker ops: op_ask, op_add_source, and
notebookId-addressed notebook resolution in _prepare_notebook.

Runs WITHOUT a live NotebookLM account: _client_with is patched to return a
deterministic FakeClient, and emit is captured.

Run with the worker's venv:  python test_session.py
"""

from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("nbl_worker", HERE / "nbl_worker.py")
nbl_worker = importlib.util.module_from_spec(spec)
assert spec is not None and spec.loader is not None
spec.loader.exec_module(nbl_worker)

EVENTS: list[dict] = []


async def _fake_emit(obj: dict) -> None:
    EVENTS.append(obj)


nbl_worker.emit = _fake_emit


class FakeNotebook:
    def __init__(self, id: str, title: str):
        self.notebook_id = id
        self.title = title


class FakeChat:
    def __init__(self, stale_conversation: bool = False):
        self.stale_conversation = stale_conversation
        self.ask_count = 0
        self.last_prompt: str | None = None
        self.last_conv_id: str | None = "__unset__"

    async def ask(self, notebook_id, prompt, conversation_id=None, source_ids=None):
        self.ask_count += 1
        self.last_prompt = prompt
        self.last_conv_id = conversation_id
        # A stale conversation: the FIRST ask with a conversation_id fails, the
        # retry (no conversation_id) succeeds.
        if self.stale_conversation and self.ask_count == 1 and conversation_id is not None:
            raise RuntimeError("conversation not found")
        return SimpleNamespace(
            conversation_id=f"conv_ret{self.ask_count}",
            turn_number=self.ask_count,
            answer=f"answer {self.ask_count}",
            references=[],
        )


class FakeSources:
    def __init__(self):
        self.added: list[tuple] = []
        self.waited: list[tuple] = []

    async def add_file(self, notebook_id, path, mime_type=None, title=None):
        self.added.append((notebook_id, str(path), title, mime_type))
        return SimpleNamespace(id=f"src{len(self.added)}", title=title)

    async def wait_until_ready(self, notebook_id, sid, timeout=None):
        self.waited.append((notebook_id, sid))
        return True


class FakeNotebooks:
    def __init__(self, notebooks: list):
        self._nbs = notebooks
        self.created: list = []

    async def list(self):
        return self._nbs

    async def create(self, title):
        nb = FakeNotebook(f"nb_created_{len(self.created)}", title)
        self.created.append(nb)
        return nb


class FakeClient:
    def __init__(self, notebooks=(), stale_conversation=False):
        self.email = "fake@example.com"
        self.notebooks = FakeNotebooks(list(notebooks))
        self.chat = FakeChat(stale_conversation)
        self.sources = FakeSources()

    async def get_account_email(self, live_fallback=False):
        return self.email


class FakeCtx:
    def __init__(self, client):
        self._client = client
        self.exited = False

    async def __aexit__(self, *a):
        self.exited = True
        return None


HOLD: dict = {}


def _install_client_with(notebooks=(), stale_conversation=False):
    async def client_with(path, timeout):
        c = FakeClient(notebooks=notebooks, stale_conversation=stale_conversation)
        HOLD["c"] = c
        return FakeCtx(c), c

    nbl_worker._client_with = client_with


async def main() -> None:
    # 1) op_ask: a normal follow-up returns the answer + a conversation id.
    _install_client_with()
    res = await nbl_worker.op_ask(
        {
            "sessionPath": "/tmp/x.json",
            "notebookId": "nb1",
            "conversationId": "conv_prev",
            "prompt": "follow up?",
            "timeoutSec": 60,
        }
    )
    assert res["notebookId"] == "nb1", res
    assert res["answer"] == "answer 1", res
    assert res["conversationId"] == "conv_ret1", res
    assert HOLD["c"].chat.last_prompt == "follow up?"
    assert HOLD["c"].chat.last_conv_id == "conv_prev"

    # 2) op_ask: a stale conversation_id is retried once, without it (fresh
    #    thread on the SAME notebook) — the question is not lost.
    EVENTS.clear()
    _install_client_with(stale_conversation=True)
    res2 = await nbl_worker.op_ask(
        {
            "sessionPath": "/tmp/x.json",
            "notebookId": "nb1",
            "conversationId": "conv_stale",
            "prompt": "again?",
            "timeoutSec": 60,
        }
    )
    assert HOLD["c"].chat.ask_count == 2, "expected a retry after the stale conversation"
    assert res2["answer"] == "answer 2", res2
    assert any(
        e.get("data", {}).get("note") == "conversation expired; retrying fresh" for e in EVENTS
    ), "the stale-conversation retry must be logged"

    # 3) op_ask without a notebookId -> ValueError (fail-closed).
    try:
        await nbl_worker.op_ask({"sessionPath": "/tmp/x.json", "prompt": "x"})
        raise AssertionError("expected ValueError for a missing notebookId")
    except ValueError:
        pass

    # 4) op_add_source: appends files to the EXISTING notebook and waits.
    _install_client_with()
    f1 = HERE / "_sess_src1.txt"
    f2 = HERE / "_sess_src2.txt"
    f1.write_text("hello")
    f2.write_text("world")
    try:
        res3 = await nbl_worker.op_add_source(
            {
                "sessionPath": "/tmp/x.json",
                "notebookId": "nb1",
                "sources": [
                    {"path": str(f1), "title": "a.txt", "mediaType": "text/plain"},
                    {"path": str(f2), "title": "b.txt", "mediaType": "text/plain"},
                ],
                "waitSec": 60,
                "timeoutSec": 60,
            }
        )
    finally:
        f1.unlink(missing_ok=True)
        f2.unlink(missing_ok=True)
    assert res3["notebookId"] == "nb1", res3
    assert res3["sourceIds"] == ["src1", "src2"], res3
    assert len(HOLD["c"].sources.added) == 2
    assert all(nid == "nb1" for nid, *_ in HOLD["c"].sources.added), "added to the session notebook"
    assert len(HOLD["c"].sources.waited) == 2, "waited for every uploaded source"

    # 5) _prepare_notebook: notebookId-first resolution (a known id never
    #    creates a second notebook, even when the title differs).
    nb = FakeNotebook("nb_exists", "Title A")
    _install_client_with(notebooks=[nb])
    prep = await nbl_worker._prepare_notebook(
        {
            "sessionPath": "/tmp/x.json",
            "notebookId": "nb_exists",
            "notebookTitle": "Other Title",
            "sources": [],
        },
        timeout_sec=60,
        wait_sec=60,
    )
    assert prep["notebook_id"] == "nb_exists", prep
    assert HOLD["c"].notebooks.created == [], "must not create a notebook when the id resolves"

    # 6) _prepare_notebook: no id -> resolve by title (reuse, no create).
    _install_client_with(notebooks=[nb])
    prep2 = await nbl_worker._prepare_notebook(
        {
            "sessionPath": "/tmp/x.json",
            "notebookId": None,
            "notebookTitle": "Title A",
            "sources": [],
        },
        timeout_sec=60,
        wait_sec=60,
    )
    assert prep2["notebook_id"] == "nb_exists", prep2
    assert HOLD["c"].notebooks.created == [], "must reuse the notebook by title"

    print(
        "session ops smoke test: OK (op_ask + stale-conversation retry + "
        "op_add_source + notebookId resolution)"
    )


if __name__ == "__main__":
    asyncio.run(main())
