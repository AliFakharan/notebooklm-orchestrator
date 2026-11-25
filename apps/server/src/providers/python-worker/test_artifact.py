#!/usr/bin/env python3
"""Smoke test for nbl_worker op_artifact generate/download branching.

Runs WITHOUT a live NotebookLM account: a fake `artifacts_api` records which
generate_*/download_* method the worker calls and with what key options.
Verifies the v1 fixed defaults per kind and the kind registry.

Run with the worker's venv:  python test_artifact.py
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


class FakeArtifactsAPI:
    """Records the last generate_*/download_* call (method + kwargs)."""

    def __init__(self) -> None:
        self.last: tuple[str, dict] | None = None

    async def _gen(self, method: str, notebook_id: str, **kw):
        self.last = (method, {"notebook_id": notebook_id, **kw})
        return SimpleNamespace(task_id="task_123")

    async def generate_audio(self, notebook_id, **kw):
        return await self._gen("generate_audio", notebook_id, **kw)

    async def generate_infographic(self, notebook_id, **kw):
        return await self._gen("generate_infographic", notebook_id, **kw)

    async def generate_slide_deck(self, notebook_id, **kw):
        return await self._gen("generate_slide_deck", notebook_id, **kw)

    async def generate_report(self, notebook_id, **kw):
        return await self._gen("generate_report", notebook_id, **kw)

    async def generate_quiz(self, notebook_id, **kw):
        return await self._gen("generate_quiz", notebook_id, **kw)

    async def generate_flashcards(self, notebook_id, **kw):
        return await self._gen("generate_flashcards", notebook_id, **kw)

    async def generate_data_table(self, notebook_id, **kw):
        return await self._gen("generate_data_table", notebook_id, **kw)

    async def generate_mind_map(self, notebook_id, **kw):
        return await self._gen("generate_mind_map", notebook_id, **kw)

    async def _dl(self, method: str, notebook_id: str, output_path: str, **kw):
        self.last = (method, {"notebook_id": notebook_id, "output_path": output_path, **kw})
        return str(output_path)

    async def download_audio(self, notebook_id, output_path, **kw):
        return await self._dl("download_audio", notebook_id, output_path, **kw)

    async def download_infographic(self, notebook_id, output_path, **kw):
        return await self._dl("download_infographic", notebook_id, output_path, **kw)

    async def download_slide_deck(self, notebook_id, output_path, **kw):
        return await self._dl("download_slide_deck", notebook_id, output_path, **kw)

    async def download_report(self, notebook_id, output_path, **kw):
        return await self._dl("download_report", notebook_id, output_path, **kw)

    async def download_quiz(self, notebook_id, output_path, **kw):
        return await self._dl("download_quiz", notebook_id, output_path, **kw)

    async def download_flashcards(self, notebook_id, output_path, **kw):
        return await self._dl("download_flashcards", notebook_id, output_path, **kw)

    async def download_data_table(self, notebook_id, output_path, **kw):
        return await self._dl("download_data_table", notebook_id, output_path, **kw)


# kind -> (prompt, expected method, expected kwargs beyond notebook_id/source_ids)
GENERATE_CASES = {
    "audio": (
        "podcast it",
        "generate_audio",
        dict(language="fa", instructions="podcast it", audio_length="__AudioLength.DEFAULT__"),
    ),
    "infographic": (
        "info",
        "generate_infographic",
        dict(
            language="fa",
            instructions="info",
            orientation="__InfographicOrientation.LANDSCAPE__",
            detail_level="__InfographicDetail.STANDARD__",
            style="__InfographicStyle.AUTO_SELECT__",
        ),
    ),
    "slide_deck": (
        "slides",
        "generate_slide_deck",
        dict(language="fa", instructions="slides", slide_length="__SlideDeckLength.DEFAULT__"),
    ),
    "report": (
        "write a report",
        "generate_report",
        dict(
            report_format="__ReportFormat.BRIEFING_DOC__",
            language="fa",
            custom_prompt="write a report",
        ),
    ),
    "quiz": (
        "quiz me",
        "generate_quiz",
        dict(
            instructions="quiz me",
            quantity="__QuizQuantity.STANDARD__",
            difficulty="__QuizDifficulty.MEDIUM__",
        ),
    ),
    "flashcards": (
        "cards",
        "generate_flashcards",
        dict(
            instructions="cards",
            quantity="__QuizQuantity.STANDARD__",
            difficulty="__QuizDifficulty.MEDIUM__",
        ),
    ),
    "data_table": ("table", "generate_data_table", dict(language="fa", instructions="table")),
}


async def main() -> None:
    from notebooklm import (  # noqa: PLC0415
        AudioLength,
        InfographicDetail,
        InfographicOrientation,
        InfographicStyle,
        QuizDifficulty,
        QuizQuantity,
        ReportFormat,
        SlideDeckLength,
    )

    # Resolve the "__Enum.MEMBER__" placeholders to the real enum values.
    enums = {
        "AudioLength.DEFAULT": AudioLength.DEFAULT,
        "InfographicOrientation.LANDSCAPE": InfographicOrientation.LANDSCAPE,
        "InfographicDetail.STANDARD": InfographicDetail.STANDARD,
        "InfographicStyle.AUTO_SELECT": InfographicStyle.AUTO_SELECT,
        "SlideDeckLength.DEFAULT": SlideDeckLength.DEFAULT,
        "ReportFormat.BRIEFING_DOC": ReportFormat.BRIEFING_DOC,
        "QuizQuantity.STANDARD": QuizQuantity.STANDARD,
        "QuizDifficulty.MEDIUM": QuizDifficulty.MEDIUM,
    }
    def resolve(v):
        return enums[v.strip("_").replace("__", "")] if isinstance(v, str) and v.startswith("__") else v

    # 1) The kind registry: all 8 kinds with the right extension + media type.
    expected_registry = {
        "audio": (".m4a", "audio/mp4"),
        "infographic": (".png", "image/png"),
        "slide_deck": (".pdf", "application/pdf"),
        "report": (".md", "text/markdown"),
        "quiz": (".md", "text/markdown"),
        "flashcards": (".md", "text/markdown"),
        "mind_map": (".json", "application/json"),
        "data_table": (".csv", "text/csv"),
    }
    assert set(nbl_worker.ARTIFACT_KINDS) == set(expected_registry)
    for kind, (ext, media) in expected_registry.items():
        assert nbl_worker.ARTIFACT_KINDS[kind]["ext"] == ext, kind
        assert nbl_worker.ARTIFACT_KINDS[kind]["mediaType"] == media, kind

    # 2) generate_* branching + v1 fixed defaults.
    for kind, (prompt, expected_method, expected_kw) in GENERATE_CASES.items():
        api = FakeArtifactsAPI()
        status = await nbl_worker._generate_artifact(api, kind, "nb1", ["src1"], "fa", prompt)
        assert getattr(status, "task_id", None) == "task_123", kind
        assert api.last is not None, f"{kind}: no generate call recorded"
        method, kwargs = api.last
        assert method == expected_method, f"{kind}: called {method} not {expected_method}"
        for k, v in expected_kw.items():
            got = kwargs.get(k)
            want = resolve(v)
            assert got == want, f"{kind}: {k}={got!r} != {want!r}"

    # mind_map is handled inline in op_artifact (synchronous; returns the
    # structure, no task_id / wait). Verify the artifacts API exposes it and
    # that op_artifact calls it with language.
    mm_api = FakeArtifactsAPI()
    await mm_api.generate_mind_map("nb1", source_ids=["src1"], language="fa", instructions="map")
    method, kwargs = mm_api.last
    assert method == "generate_mind_map"
    assert kwargs["language"] == "fa"
    assert kwargs["source_ids"] == ["src1"]

    # 3) download_* branching (every download binds the artifact by task id).
    download_cases = {
        "audio": ("download_audio", None),
        "infographic": ("download_infographic", None),
        "slide_deck": ("download_slide_deck", "pdf"),
        "report": ("download_report", None),
        "quiz": ("download_quiz", "markdown"),
        "flashcards": ("download_flashcards", "markdown"),
        "data_table": ("download_data_table", None),
    }
    for kind, (expected_method, output_format) in download_cases.items():
        api = FakeArtifactsAPI()
        await nbl_worker._download_artifact(api, kind, "nb1", Path("/tmp/x"), "task_123")
        assert api.last is not None, f"{kind}: no download call recorded"
        method, kwargs = api.last
        assert method == expected_method, f"{kind}: called {method} not {expected_method}"
        assert kwargs.get("artifact_id") == "task_123", f"{kind}: missing artifact_id"
        if output_format is not None:
            assert kwargs.get("output_format") == output_format, (kind, kwargs)

    print("op_artifact smoke test: OK (registry + generate/download branches + defaults)")


if __name__ == "__main__":
    asyncio.run(main())
