"""Common engine interface + helpers."""
from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Callable

ProgressCb = Callable[[int, str], None]


class SvcEngineError(RuntimeError):
    pass


def _module_present(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except Exception:
        return False


class SvcEngine:
    """Adapter contract implemented by the so-vits-svc engine."""

    name = "base"

    # --- availability --------------------------------------------------
    def infer_available(self) -> bool:
        raise NotImplementedError

    def train_available(self, device: str) -> tuple[bool, str]:
        """Return (available, note). Note explains gating (e.g. needs CUDA)."""
        raise NotImplementedError

    # --- work ----------------------------------------------------------
    def convert(
        self,
        input_wav: Path,
        voice_dir: Path,
        out_wav: Path,
        device: str,
        transpose: int = 0,
    ) -> Path:
        raise NotImplementedError

    def train(
        self,
        samples: list[Path],
        voice_dir: Path,
        device: str,
        progress_cb: ProgressCb,
        max_epochs: int | None = None,
    ) -> None:
        raise NotImplementedError
