"""SVC engine adapters (so-vits-svc only).

The adapter is import-safe: importing this package never imports the heavy
engine library. Availability is checked lazily so the sidecar can boot and
report capabilities even when dependencies are not installed yet.
"""
from __future__ import annotations

from .sovits import SoVitsEngine

ENGINES = {
    "sovits": SoVitsEngine,
}


def get_engine(name: str):
    cls = ENGINES.get((name or "").lower())
    if cls is None:
        raise ValueError(f"未知 SVC 引擎: {name}")
    return cls()
