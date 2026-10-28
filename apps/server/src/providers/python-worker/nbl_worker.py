#!/usr/bin/env python3
"""NotebookLM Orchestrator — Python worker for notebooklm-py.

JSON-line protocol (one JSON object per line, LF-terminated):

  request : {"id": <int>, "op": <str>, "params": {...}}
  response: {"id": <int>, "ok": true,  "result": {...}}
            {"id": <int>, "ok": false, "error": {"code": <str>, "message": <str>}}
  event   : {"event": "progress"|"log", "op": <int|null>, "data": {...}}

Ops:
  ping            -> {"version", "notebooklmPy", "playwright": bool}
  validate        {sessionPath} -> {ok, exists, email?}
  verify          {sessionPath, timeoutSec} -> {email, notebooks, checkedAt}
  job             {sessionPath, audioPath, audioName, prompt,
                   notebookTitle, waitSec, timeoutSec}
                  -> {email, notebookId, notebookTitle, sourceId,
                      uploaded, conversationId, turnNumber, answer,
                      references, checkedAt}

Security notes:
  * The worker is spawned per job with NO shell.
  * Session files are read directly from the app's private storage (0600).
  * Nothing sensitive is printed; progress events carry only counters/ids.
  * Proxy routing (when required) is done via HTTPS_PROXY/HTTP_PROXY/
    ALL_PROXY env vars set by the supervisor BEFORE spawn — the notebooklm-py
    web client honors them (default trust_env). See docs/proxy-design.md.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Output plumbing: a single global write lock so JSON lines never interleave.
# ---------------------------------------------------------------------------
_write_lock = asyncio.Lock()


async def emit(obj: dict[str, Any]) -> None:
    line = json.dumps(obj, ensure_ascii=False)
    async with _write_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Error mapping: notebooklm-py exceptions -> stable error codes.
# ---------------------------------------------------------------------------
def _classify(exc: BaseException) -> tuple[str, str]:
    try:
        from notebooklm.exceptions import (
            AuthError,
            AuthExtractionError,
            ConfigurationError,
            HeadlessLoginRequiredError,
            MissingDependencyError,
            NetworkError,
            NotFoundError,
            NonIdempotentRetryError,
            RateLimitError,
            ServerError,
            ValidationError,
            WaitTimeoutError,
        )
    except ImportError:  # notebooklm-py not importable
        return "provider_unavailable", f"notebooklm-py import failed: {exc}"

    def code(name: str, msg: str) -> tuple[str, str]:
        return name, msg

    if isinstance(exc, (AuthError, AuthExtractionError, HeadlessLoginRequiredError)):
        return code("auth", str(exc))
    if isinstance(exc, RateLimitError):
        return code("rate_limit", str(exc))
    if isinstance(exc, WaitTimeoutError):
        return code("timeout", str(exc))
    if isinstance(exc, NetworkError):
        return code("connectivity", str(exc))
    if isinstance(exc, ValidationError):
        return code("invalid_input", str(exc))
    if isinstance(exc, NotFoundError):
        return code("not_found", str(exc))
    if isinstance(exc, NonIdempotentRetryError):
        return code("ambiguous", str(exc))
    if isinstance(exc, MissingDependencyError):
        return code("provider_unavailable", str(exc))
    if isinstance(exc, ConfigurationError):
        return code("configuration", str(exc))
    if isinstance(exc, ServerError):
        return code("provider", str(exc))
    return "unknown", f"{type(exc).__name__}: {exc}"


# ---------------------------------------------------------------------------
# Ops
# ---------------------------------------------------------------------------
async def op_ping(_p: dict[str, Any]) -> dict[str, Any]:
    import importlib.metadata as md

    version = None
    try:
        version = md.version("notebooklm-py")
    except md.PackageNotFoundError:
        version = None
    has_playwright = None
    try:
        import playwright  # noqa: F401

        has_playwright = True
    except ImportError:
        has_playwright = False
    return {"version": version, "playwright": has_playwright}


def _secure_write(path: Path, data: bytes) -> None:
    """Atomic write with 0600 permissions."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-session-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


async def _client_with(path: Path, timeout_sec: float):
    from notebooklm import NotebookLMClient

    ctx = NotebookLMClient.from_storage(path=str(path), timeout=float(timeout_sec))
    client = await ctx.__aenter__()
    return ctx, client


async def op_validate(p: dict[str, Any]) -> dict[str, Any]:
    session = Path(p["sessionPath"])
    out: dict[str, Any] = {"ok": False, "exists": session.exists(), "email": None}
    if not out["exists"]:
        return out
    ctx, client = await _client_with(session, 30.0)
    try:
        email = await client.get_account_email(live_fallback=False)
        out["email"] = email
        out["ok"] = bool(email)
    finally:
        await ctx.__aexit__(None, None, None)
    return out


async def op_verify(p: dict[str, Any]) -> dict[str, Any]:
    session = Path(p["sessionPath"])
    timeout = float(p.get("timeoutSec", 60))
    ctx, client = await _client_with(session, timeout)
    try:
        email = await client.get_account_email(live_fallback=True)
        notebooks = await client.notebooks.list()
        return {
            "email": email,
            "notebooks": len(notebooks),
            "checkedAt": now_iso(),
        }
    finally:
        await ctx.__aexit__(None, None, None)


async def op_job(p: dict[str, Any]) -> dict[str, Any]:
    session = Path(p["sessionPath"])
    audio_path = Path(p["audioPath"])
    audio_name = p.get("audioName") or audio_path.name
    prompt = str(p["prompt"])
    notebook_title = str(p["notebookTitle"])
    wait_sec = float(p.get("waitSec", 600))
    timeout_sec = float(p.get("timeoutSec", 1800))

    async def _progress(stage: str, **data: Any) -> None:
        await emit({"event": "progress", "op": None, "data": {"stage": stage, **data}})

    if not audio_path.is_file():
        raise FileNotFoundError(f"audio file not found: {audio_path}")

    await _progress("opening_session")
    ctx, client = await _client_with(session, min(timeout_sec, 300))
    try:
        email = await client.get_account_email(live_fallback=True)
        await _progress("selecting_notebook")
        notebooks = await client.notebooks.list()
        nb = next(
            (n for n in notebooks if getattr(n, "title", None) == notebook_title), None
        )
        if nb is None:
            nb = await client.notebooks.create(title=notebook_title)
            await _progress(
                "notebook_created", notebookId=getattr(nb, "notebook_id", None)
            )
        notebook_id = getattr(nb, "notebook_id", None) or getattr(nb, "id", None)

        # NOTE: notebooklm-py's Source model identifies a source via `.id`
        # (older builds used `.source_id`), so every read falls back to `.id`.
        # A missing id here would otherwise surface as "Source not found: None"
        # from wait_until_ready.
        def _src_id(s: Any) -> str | None:
            return getattr(s, "source_id", None) or getattr(s, "id", None)

        # Idempotency anchor: reuse an existing source with the same title
        # instead of double-uploading on a safe retry.
        uploaded = True
        source = None
        try:
            sources = await client.sources.list(notebook_id)
            source = next(
                (s for s in sources if getattr(s, "title", None) == audio_name), None
            )
        except Exception:
            source = None
        if source is not None:
            uploaded = False
            await _progress("source_reused", sourceId=_src_id(source))
        else:
            await _progress("uploading_audio")
            source = await client.sources.add_file(
                notebook_id,
                audio_path,
                title=audio_name,
            )
            await _progress("upload_done", sourceId=_src_id(source))

        source_id = _src_id(source)
        if not source_id:
            raise RuntimeError(
                "audio upload reported success but returned no source id "
                f"(source={type(source).__name__}); cannot wait for processing"
            )
        await _progress("waiting_for_processing")
        await client.sources.wait_until_ready(notebook_id, source_id, timeout=wait_sec)
        await _progress("processing_done")

        await _progress("executing_prompt")
        result = await client.chat.ask(notebook_id, prompt, source_ids=[source_id])
        await _progress("prompt_done")

        refs = []
        for r in getattr(result, "references", None) or []:
            refs.append(
                {
                    "sourceId": getattr(r, "source_id", None),
                    "quote": getattr(r, "quote", None),
                }
            )

        return {
            "email": email,
            "notebookId": notebook_id,
            "notebookTitle": notebook_title,
            "sourceId": source_id,
            "uploaded": uploaded,
            "conversationId": getattr(result, "conversation_id", None),
            "turnNumber": getattr(result, "turn_number", None),
            "answer": getattr(result, "answer", "") or "",
            "references": refs,
            "checkedAt": now_iso(),
        }
    finally:
        await ctx.__aexit__(None, None, None)


OPS = {
    "ping": op_ping,
    "validate": op_validate,
    "verify": op_verify,
    "job": op_job,
}


async def main() -> None:
    loop = asyncio.get_running_loop()
    stop = loop.create_future()

    def _on_term(signum, _frame):
        if not stop.done():
            stop.set_result(None)

    signal.signal(signal.SIGTERM, _on_term)
    signal.signal(signal.SIGINT, _on_term)

    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    async def feed() -> None:
        while True:
            line = await reader.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line.decode("utf-8"))
            except json.JSONDecodeError as e:
                await emit(
                    {
                        "id": None,
                        "ok": False,
                        "error": {"code": "protocol", "message": f"bad json: {e}"},
                    }
                )
                continue
            rid = req.get("id")
            op = req.get("op")
            params = req.get("params") or {}
            handler = OPS.get(op)
            if handler is None:
                await emit(
                    {
                        "id": rid,
                        "ok": False,
                        "error": {"code": "protocol", "message": f"unknown op: {op}"},
                    }
                )
                continue
            try:
                result = await handler(params)
                await emit({"id": rid, "ok": True, "result": result})
            except Exception as exc:  # noqa: BLE001 - boundary: classify everything
                code, message = _classify(exc)
                await emit(
                    {
                        "id": rid,
                        "ok": False,
                        "error": {"code": code, "message": message[:2000]},
                    }
                )

    await asyncio.gather(feed(), stop)


if __name__ == "__main__":
    asyncio.run(main())
