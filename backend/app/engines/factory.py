"""Engine selection based on runtime settings / per-job override."""
from __future__ import annotations

from ..config import RuntimeSettings, load_runtime_settings
from .base import SeparationEngine
from .demucs_engine import DemucsEngine
from .lalal_engine import LalalEngine


def get_engine(engine_name: str | None = None, rs: RuntimeSettings | None = None) -> SeparationEngine:
    """Return a configured engine instance.

    `engine_name` (per-job override) takes precedence over the runtime default.
    Falls back to Demucs if LALAL.AI is requested but no key is configured.
    """
    rs = rs or load_runtime_settings()
    name = engine_name or rs.default_engine

    if name == "lalal":
        if rs.lalal_api_key:
            return LalalEngine(api_key=rs.lalal_api_key)
        # Requested LALAL without a key -> fall back to Demucs.
        return DemucsEngine()
    return DemucsEngine()


def capabilities_for(engine_name: str | None = None, rs: RuntimeSettings | None = None) -> tuple[str, set[str]]:
    """Return (effective_engine_name, supported_stem_ids).

    Computed without loading any heavy model: the Demucs engine derives its
    supported stems from the configured source list + cascade flag.
    """
    rs = rs or load_runtime_settings()
    name = engine_name or rs.default_engine
    if name == "lalal" and rs.lalal_api_key:
        return "lalal", LalalEngine(api_key=rs.lalal_api_key).supported_stems()
    return "demucs", DemucsEngine().supported_stems()
