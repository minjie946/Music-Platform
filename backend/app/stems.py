"""Canonical stem definitions shared across engines and the API.

We expose 10 user-facing stem types. Each engine declares which of these it can
truly isolate via its capability set; the frontend greys out unsupported ones.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class StemDef:
    id: str
    label_zh: str
    label_en: str


# Ordered list defines the display order in the UI.
STEMS: list[StemDef] = [
    StemDef("lead_vocals", "主唱", "Lead Vocals"),
    StemDef("backing_vocals", "伴唱", "Backing Vocals"),
    StemDef("drums", "鼓", "Drums"),
    StemDef("bass", "贝斯", "Bass"),
    StemDef("guitar", "吉他", "Guitar"),
    StemDef("acoustic_guitar", "原声木吉他", "Acoustic Guitar"),
    StemDef("electric_guitar", "电吉他", "Electric Guitar"),
    StemDef("piano", "钢琴", "Piano"),
    StemDef("synth", "合成器", "Synthesizer"),
    StemDef("strings", "弦乐", "Strings"),
    StemDef("other", "其余", "Other"),
]

STEM_BY_ID: dict[str, StemDef] = {s.id: s for s in STEMS}


def is_valid_stem(stem_id: str) -> bool:
    return stem_id in STEM_BY_ID
