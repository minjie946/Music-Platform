"""Separation engine abstraction.

Every engine declares the set of canonical stem ids it can truly isolate and
implements `separate`, which writes one audio file per requested+supported stem
into `out_dir` and reports coarse progress via `progress_cb(percent, stage)`.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Callable

ProgressCb = Callable[[int, str], None]


class EngineError(RuntimeError):
    """Raised when an engine fails in an expected, user-presentable way."""


class SeparationEngine(ABC):
    #: Engine identifier used in settings and API responses.
    name: str = "base"

    @abstractmethod
    def supported_stems(self) -> set[str]:
        """Canonical stem ids this engine can isolate."""

    @abstractmethod
    def separate(
        self,
        audio_path: str,
        stems: list[str],
        out_dir: str,
        progress_cb: ProgressCb,
        output_format: str = "wav",
    ) -> dict[str, str]:
        """Separate `audio_path` into the requested stems.

        Returns a mapping of stem id -> absolute output file path. Only stems
        that are both requested and supported should be produced. ``output_format``
        selects the exported container ("wav" for lossless, "mp3" for compressed).
        """

    def filter_supported(self, requested: list[str]) -> list[str]:
        supported = self.supported_stems()
        return [s for s in requested if s in supported]
