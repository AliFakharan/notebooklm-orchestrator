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
  job             {sessionPath, sources: [{path, title, mediaType}],
                   prompt, notebookTitle, notebookId?, waitSec, timeoutSec}
               -> {email, notebookId, notebookTitle,
                   sources: [{title, sourceId, reused}],
                   conversationId, turnNumber, answer,
                   references, checkedAt}
  artifact        {sessionPath, output: <kind>, language?, sources,
                   prompt, notebookTitle, notebookId?, waitSec, timeoutSec}
               -> {email, notebookId, notebookTitle, kind,
                   artifact: {name, mediaType, path}, checkedAt}
  ask             {sessionPath, notebookId, conversationId?, prompt,
                   timeoutSec}
               -> {email, notebookId, conversationId, turnNumber, answer,
                   references, checkedAt}
  add_source      {sessionPath, notebookId, sources: [{path, title, mediaType}],
                   waitSec, timeoutSec}
               -> {email, notebookId,
                   sources: [{title, sourceId, reused}], sourceIds, checkedAt}

  `job`/`artifact`/`ask`/`add_source` all accept an optional `notebookId` that
  addresses an EXISTING notebook by id (a persistent session anchor) instead of
  resolving it by `notebookTitle`. When `notebookId` is present the notebook is
  looked up by id; `notebookTitle` is the fallback/creation key.

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
from uuid import uuid4

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

    # Raw transport failures that notebooklm-py did NOT wrap into its own
    # exception types. Observed live: an httpx.ReadTimeout escaping rpc_call
    # (the heavy ListRecentlyViewedProjects read stalls through a flaky
    # tunnel) reaches _classify unwrapped. These are NBL-destination failures
    # THROUGH the node's tunnel, so they must classify as "connectivity" —
    # the only class that triggers verify failover (try the next node) and
    # node quarantine / auto-delete accounting. The old default ("unknown")
    # silently disabled the whole failover mechanism for exactly this case.
    try:
        import httpx  # noqa: PLC0415 - transport dep, present with notebooklm-py

        if isinstance(exc, (httpx.TimeoutException, httpx.RequestError)):
            return code("connectivity", f"{type(exc).__name__}: {exc}".strip())
    except ImportError:
        pass

    import socket  # noqa: PLC0415 - built-in network-family fallback

    # TimeoutError (== asyncio.TimeoutError / socket.timeout on 3.10+),
    # ConnectionError and DNS failures: all route-level, all the node's fault.
    # WaitTimeoutError already matched above, so it keeps its "timeout" class.
    if isinstance(exc, (TimeoutError, ConnectionError, socket.gaierror)):
        return code("connectivity", f"{type(exc).__name__}: {exc}".strip())

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


async def _prepare_notebook(
    p: dict[str, Any], *, timeout_sec: float, wait_sec: float
) -> dict[str, Any]:
    """Open the session, resolve (select/create) the notebook, upload any
    sources and wait for them to finish processing.

    Emits the same progress stages as the original inline code
    (opening_session → selecting_notebook → uploading_sources →
    processing_done). Returns a dict: ctx, client, email, notebook_id,
    notebook_title, resolved (list of {title, sourceId, reused}), source_ids.
    The CALLER is responsible for closing the client via ctx.__aexit__.
    """
    session = Path(p["sessionPath"])
    notebook_id_hint = p.get("notebookId") or None
    notebook_title = str(p.get("notebookTitle") or "")
    # 0..N sources, each {path, title, mediaType}.
    srcs = p.get("sources") or []
    sources: list[dict[str, Any]] = []
    for s in srcs:
        sp = Path(str(s["path"]))
        if not sp.is_file():
            raise FileNotFoundError(f"source file not found: {sp}")
        sources.append(
            {
                "path": sp,
                "title": str(s.get("title") or sp.name),
                "mediaType": s.get("mediaType") or None,
            }
        )

    async def _progress(stage: str, **data: Any) -> None:
        await emit({"event": "progress", "op": None, "data": {"stage": stage, **data}})

    await _progress("opening_session")
    ctx, client = await _client_with(session, min(timeout_sec, 300))
    email = await client.get_account_email(live_fallback=True)
    await _progress("selecting_notebook")
    notebooks = await client.notebooks.list()
    # Resolve the notebook: by id first (a persistent session anchor), then by
    # title (fallback / fresh creation). A session with a known notebookId
    # never creates a second notebook even if the title drifted.
    nb = None
    if notebook_id_hint:
        nb = next(
            (
                n
                for n in notebooks
                if (getattr(n, "notebook_id", None) or getattr(n, "id", None)) == notebook_id_hint
            ),
            None,
        )
    if nb is None and notebook_title:
        nb = next((n for n in notebooks if getattr(n, "title", None) == notebook_title), None)
    if nb is None and notebook_title:
        nb = await client.notebooks.create(title=notebook_title)
        await _progress("notebook_created", notebookId=getattr(nb, "notebook_id", None))
    if nb is None:
        raise ValueError("no notebookId or notebookTitle provided to resolve a notebook")
    notebook_id = getattr(nb, "notebook_id", None) or getattr(nb, "id", None)

    # NOTE: notebooklm-py's Source model identifies a source via `.id`
    # (older builds used `.source_id`), so every read falls back to `.id`.
    # A missing id here would otherwise surface as "Source not found: None"
    # from wait_until_ready.
    def _src_id(s: Any) -> str | None:
        return getattr(s, "source_id", None) or getattr(s, "id", None)

    # Idempotency anchor: on a safe retry, reuse an existing source whose
    # title matches instead of double-uploading.
    existing: list[Any] = []
    try:
        existing = await client.sources.list(notebook_id)
    except Exception:
        existing = []

    resolved: list[dict[str, Any]] = []
    if sources:
        await _progress("uploading_sources", count=len(sources))
    for s in sources:
        match = next(
            (x for x in existing if getattr(x, "title", None) == s["title"]), None
        )
        if match is not None:
            await _progress("source_reused", title=s["title"], sourceId=_src_id(match))
            resolved.append({"title": s["title"], "sourceId": _src_id(match), "reused": True})
            continue
        uploaded = await client.sources.add_file(
            notebook_id,
            s["path"],
            mime_type=s["mediaType"],
            title=s["title"],
        )
        await _progress("upload_done", title=s["title"], sourceId=_src_id(uploaded))
        resolved.append({"title": s["title"], "sourceId": _src_id(uploaded), "reused": False})

    source_ids = [sid for sid in (r["sourceId"] for r in resolved) if sid]
    for r in resolved:
        if not r["sourceId"]:
            raise RuntimeError(
                f"upload for {r['title']!r} reported success but returned no "
                "source id; cannot wait for processing"
            )

    # Wait for every source to finish processing (sequential: one at a
    # time keeps the per-source wait bounded and progress meaningful).
    if source_ids:
        await _progress("waiting_for_processing")
    for i, sid in enumerate(source_ids):
        await client.sources.wait_until_ready(notebook_id, sid, timeout=wait_sec)
        await _progress("processing_done", index=i + 1, of=len(source_ids))

    return {
        "ctx": ctx,
        "client": client,
        "email": email,
        "notebook_id": notebook_id,
        "notebook_title": notebook_title,
        "resolved": resolved,
        "source_ids": source_ids,
    }


async def op_job(p: dict[str, Any]) -> dict[str, Any]:
    prompt = str(p["prompt"])
    wait_sec = float(p.get("waitSec", 600))
    timeout_sec = float(p.get("timeoutSec", 1800))
    prep = await _prepare_notebook(p, timeout_sec=timeout_sec, wait_sec=wait_sec)
    client = prep["client"]
    try:
        await emit(
            {"event": "progress", "op": None, "data": {"stage": "executing_prompt"}}
        )
        result = await client.chat.ask(
            prep["notebook_id"], prompt, source_ids=prep["source_ids"] or None
        )
        await emit({"event": "progress", "op": None, "data": {"stage": "prompt_done"}})

        refs = []
        for r in getattr(result, "references", None) or []:
            refs.append(
                {
                    "sourceId": getattr(r, "source_id", None),
                    "quote": getattr(r, "quote", None),
                }
            )

        return {
            "email": prep["email"],
            "notebookId": prep["notebook_id"],
            "notebookTitle": prep["notebook_title"],
            "sources": prep["resolved"],
            "conversationId": getattr(result, "conversation_id", None),
            "turnNumber": getattr(result, "turn_number", None),
            "answer": getattr(result, "answer", "") or "",
            "references": refs,
            "checkedAt": now_iso(),
        }
    finally:
        await prep["ctx"].__aexit__(None, None, None)


# ---------------------------------------------------------------------------
# Artifact generation (op_artifact). Each kind maps to a notebooklm-py
# generate_* + download_* pair with the fixed v1 defaults. mind_map is
# synchronous (returns the parsed structure, no task_id / wait).
# ---------------------------------------------------------------------------
ARTIFACT_KINDS: dict[str, dict[str, str]] = {
    "audio": {"ext": ".m4a", "mediaType": "audio/mp4"},
    "infographic": {"ext": ".png", "mediaType": "image/png"},
    "slide_deck": {"ext": ".pdf", "mediaType": "application/pdf"},
    "report": {"ext": ".md", "mediaType": "text/markdown"},
    "quiz": {"ext": ".md", "mediaType": "text/markdown"},
    "flashcards": {"ext": ".md", "mediaType": "text/markdown"},
    "mind_map": {"ext": ".json", "mediaType": "application/json"},
    "data_table": {"ext": ".csv", "mediaType": "text/csv"},
}


async def _generate_artifact(
    artifacts_api: Any,
    kind: str,
    notebook_id: str,
    source_ids: list[str] | None,
    language: str,
    prompt: str,
) -> Any:
    """Kick off generation for `kind`; return the result (a GenerationStatus
    with a task_id for every kind except mind_map)."""
    if kind == "audio":
        from notebooklm import AudioLength

        return await artifacts_api.generate_audio(
            notebook_id,
            source_ids=source_ids,
            language=language,
            instructions=prompt or None,
            audio_length=AudioLength.DEFAULT,
        )
    if kind == "infographic":
        from notebooklm import InfographicDetail, InfographicOrientation, InfographicStyle

        return await artifacts_api.generate_infographic(
            notebook_id,
            source_ids=source_ids,
            language=language,
            instructions=prompt or None,
            orientation=InfographicOrientation.LANDSCAPE,
            detail_level=InfographicDetail.STANDARD,
            style=InfographicStyle.AUTO_SELECT,
        )
    if kind == "slide_deck":
        from notebooklm import SlideDeckLength

        return await artifacts_api.generate_slide_deck(
            notebook_id,
            source_ids=source_ids,
            language=language,
            instructions=prompt or None,
            slide_length=SlideDeckLength.DEFAULT,
        )
    if kind == "report":
        from notebooklm import ReportFormat

        return await artifacts_api.generate_report(
            notebook_id,
            report_format=ReportFormat.BRIEFING_DOC,
            source_ids=source_ids,
            language=language,
            custom_prompt=prompt or None,
        )
    if kind == "quiz":
        from notebooklm import QuizDifficulty, QuizQuantity

        return await artifacts_api.generate_quiz(
            notebook_id,
            source_ids=source_ids,
            instructions=prompt or None,
            quantity=QuizQuantity.STANDARD,
            difficulty=QuizDifficulty.MEDIUM,
        )
    if kind == "flashcards":
        from notebooklm import QuizDifficulty, QuizQuantity

        return await artifacts_api.generate_flashcards(
            notebook_id,
            source_ids=source_ids,
            instructions=prompt or None,
            quantity=QuizQuantity.STANDARD,
            difficulty=QuizDifficulty.MEDIUM,
        )
    if kind == "data_table":
        return await artifacts_api.generate_data_table(
            notebook_id,
            source_ids=source_ids,
            language=language,
            instructions=prompt or None,
        )
    raise ValueError(f"unknown artifact kind: {kind}")


async def _download_artifact(
    artifacts_api: Any, kind: str, notebook_id: str, out_path: Path, task_id: str
) -> None:
    """Download a completed artifact to out_path (format per kind)."""
    dest = str(out_path)
    if kind == "audio":
        await artifacts_api.download_audio(notebook_id, dest, artifact_id=task_id)
    elif kind == "infographic":
        await artifacts_api.download_infographic(notebook_id, dest, artifact_id=task_id)
    elif kind == "slide_deck":
        await artifacts_api.download_slide_deck(
            notebook_id, dest, artifact_id=task_id, output_format="pdf"
        )
    elif kind == "report":
        await artifacts_api.download_report(notebook_id, dest, artifact_id=task_id)
    elif kind == "quiz":
        await artifacts_api.download_quiz(
            notebook_id, dest, artifact_id=task_id, output_format="markdown"
        )
    elif kind == "flashcards":
        await artifacts_api.download_flashcards(
            notebook_id, dest, artifact_id=task_id, output_format="markdown"
        )
    elif kind == "data_table":
        await artifacts_api.download_data_table(notebook_id, dest, artifact_id=task_id)
    else:
        raise ValueError(f"unknown artifact kind: {kind}")


async def op_artifact(p: dict[str, Any]) -> dict[str, Any]:
    kind = str(p.get("output") or "")
    if kind not in ARTIFACT_KINDS:
        raise ValueError(
            f"invalid artifact output: {kind!r} (allowed: {', '.join(ARTIFACT_KINDS)})"
        )
    language = str(p.get("language") or "fa")
    prompt = str(p.get("prompt") or "")
    wait_sec = float(p.get("waitSec", 1800))
    timeout_sec = float(p.get("timeoutSec", 1800))
    meta = ARTIFACT_KINDS[kind]

    prep = await _prepare_notebook(p, timeout_sec=timeout_sec, wait_sec=wait_sec)
    client = prep["client"]
    notebook_id = prep["notebook_id"]
    source_ids: list[str] | None = prep["source_ids"] or None
    try:
        await emit(
            {
                "event": "progress",
                "op": None,
                "data": {"stage": "generating_artifact", "kind": kind},
            }
        )

        out_dir = Path(tempfile.gettempdir()) / "nlo-artifacts"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"artifact-{kind}-{uuid4().hex[:12]}{meta['ext']}"

        if kind == "mind_map":
            # Synchronous: returns the parsed structure (no task_id / wait).
            result = await client.artifacts.generate_mind_map(
                notebook_id,
                source_ids=source_ids,
                language=language,
                instructions=prompt or None,
            )
            structure = getattr(result, "mind_map", None)
            if structure is None:
                raise RuntimeError("mind map generation returned an empty structure")
            out_path.write_text(
                json.dumps(structure, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        else:
            status = await _generate_artifact(
                client.artifacts, kind, notebook_id, source_ids, language, prompt
            )
            task_id = getattr(status, "task_id", None)
            if not task_id:
                raise RuntimeError("generation kickoff returned no task id")
            # wait_for_completion raises a WaitTimeoutError subclass on
            # timeout (_classify maps it to "timeout").
            status = await client.artifacts.wait_for_completion(
                notebook_id, task_id, timeout=wait_sec
            )
            if status.is_failed:
                from notebooklm import RateLimitError, ServerError

                if status.is_rate_limited:
                    raise RateLimitError(
                        f"artifact generation rate limited: {status.error or 'quota/rate limit'}"
                    )
                raise ServerError(f"artifact generation failed: {status.error or 'unknown'}")
            await _download_artifact(client.artifacts, kind, notebook_id, out_path, task_id)

        if not out_path.is_file() or out_path.stat().st_size == 0:
            raise RuntimeError(f"artifact download produced no file: {kind}")

        await emit({"event": "progress", "op": None, "data": {"stage": "artifact_done"}})
        return {
            "email": prep["email"],
            "notebookId": notebook_id,
            "notebookTitle": prep["notebook_title"],
            "kind": kind,
            "artifact": {
                "name": out_path.name,
                "mediaType": meta["mediaType"],
                "path": str(out_path),
            },
            "checkedAt": now_iso(),
        }
    finally:
        await prep["ctx"].__aexit__(None, None, None)


# ---------------------------------------------------------------------------
# Session ops. A persistent session anchors on a notebook_id (and, for
# follow-up questions, a conversation_id). These open the client, address the
# EXISTING notebook by id, and perform a single re-entrant operation — they
# never create a notebook (that happens on the session's first `job`).
# ---------------------------------------------------------------------------
def _require_notebook_id(p: dict[str, Any]) -> str:
    notebook_id = p.get("notebookId")
    if not notebook_id:
        raise ValueError("notebookId is required for this op")
    return str(notebook_id)


def _collect_refs(result: Any) -> list[dict[str, Any]]:
    refs = []
    for r in getattr(result, "references", None) or []:
        refs.append(
            {
                "sourceId": getattr(r, "source_id", None),
                "quote": getattr(r, "quote", None),
            }
        )
    return refs


async def op_ask(p: dict[str, Any]) -> dict[str, Any]:
    """A follow-up question on a session's conversation.

    If the stored conversation_id is stale (Google dropped it), the ask fails
    and we RETRY once without it — starting a fresh conversation on the SAME
    notebook (the notebook is preserved; only the thread restarts).
    """
    notebook_id = _require_notebook_id(p)
    prompt = str(p["prompt"])
    timeout_sec = float(p.get("timeoutSec", 1800))
    conversation_id = p.get("conversationId") or None

    await emit({"event": "progress", "op": None, "data": {"stage": "executing_prompt"}})
    ctx, client = await _client_with(Path(p["sessionPath"]), min(timeout_sec, 300))
    try:
        try:
            result = await client.chat.ask(
                notebook_id, prompt, conversation_id=conversation_id
            )
        except Exception as exc:  # noqa: BLE001 - retry a stale conversation once
            if not conversation_id:
                raise
            # A dead conversation_id must not lose the user's question: retry
            # on the same notebook with a fresh thread.
            await emit(
                {"event": "log", "op": None, "data": {"note": "conversation expired; retrying fresh"}}
            )
            result = await client.chat.ask(notebook_id, prompt)
        await emit({"event": "progress", "op": None, "data": {"stage": "prompt_done"}})
        return {
            "email": await client.get_account_email(live_fallback=False),
            "notebookId": notebook_id,
            "conversationId": getattr(result, "conversation_id", None),
            "turnNumber": getattr(result, "turn_number", None),
            "answer": getattr(result, "answer", "") or "",
            "references": _collect_refs(result),
            "checkedAt": now_iso(),
        }
    finally:
        await ctx.__aexit__(None, None, None)


async def op_add_source(p: dict[str, Any]) -> dict[str, Any]:
    """Append files to a session's existing notebook and wait for processing."""
    notebook_id = _require_notebook_id(p)
    wait_sec = float(p.get("waitSec", 600))
    timeout_sec = float(p.get("timeoutSec", 1800))
    srcs = p.get("sources") or []

    ctx, client = await _client_with(Path(p["sessionPath"]), min(timeout_sec, 300))
    try:
        resolved: list[dict[str, Any]] = []
        source_ids: list[str] = []
        for i, s in enumerate(srcs):
            sp = Path(str(s["path"]))
            if not sp.is_file():
                raise FileNotFoundError(f"source file not found: {sp}")
            title = str(s.get("title") or sp.name)
            await emit(
                {"event": "progress", "op": None, "data": {"stage": "uploading_sources", "index": i}}
            )
            uploaded = await client.sources.add_file(
                notebook_id,
                sp,
                mime_type=s.get("mediaType") or None,
                title=title,
            )
            # notebooklm-py's Source model uses `.id` (older builds `.source_id`).
            sid = getattr(uploaded, "source_id", None) or getattr(uploaded, "id", None)
            if not sid:
                raise RuntimeError(f"upload for {title!r} returned no source id")
            await emit(
                {"event": "progress", "op": None, "data": {"stage": "upload_done", "title": title}}
            )
            resolved.append({"title": title, "sourceId": sid, "reused": False})
            source_ids.append(sid)

        if source_ids:
            await emit({"event": "progress", "op": None, "data": {"stage": "waiting_for_processing"}})
        for i, sid in enumerate(source_ids):
            await client.sources.wait_until_ready(notebook_id, sid, timeout=wait_sec)
            await emit(
                {"event": "progress", "op": None, "data": {"stage": "processing_done", "index": i + 1}}
            )

        return {
            "email": await client.get_account_email(live_fallback=False),
            "notebookId": notebook_id,
            "sources": resolved,
            "sourceIds": source_ids,
            "checkedAt": now_iso(),
        }
    finally:
        await ctx.__aexit__(None, None, None)


OPS = {
    "ping": op_ping,
    "validate": op_validate,
    "verify": op_verify,
    "job": op_job,
    "artifact": op_artifact,
    "ask": op_ask,
    "add_source": op_add_source,
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
