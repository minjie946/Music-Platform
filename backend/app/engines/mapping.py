"""Mapping between a Demucs model's source names and our canonical stem ids.

This lets the engine work with ANY Demucs model:
- The stock ``htdemucs_6s`` (sources: drums, bass, other, vocals, guitar, piano)
- A custom-trained 10-source model whose sources are named exactly as our
  canonical stem ids (lead_vocals, backing_vocals, ...)

Capabilities can be computed cheaply (without loading the model) from a small
registry of known model -> sources, plus an optional override for custom models.
"""
from __future__ import annotations

# Model source name -> canonical stem id.
# Identity entries make a custom model whose sources already use canonical names
# map 1:1. Aliases bridge the stock model / other taxonomies.
# NOTE: the stock 6-stem "guitar" is a *combined* guitar (electric + acoustic);
# we expose it as the generic "guitar" stem rather than guessing the sub-type.
SOURCE_TO_CANONICAL: dict[str, str] = {
    # identity (canonical names)
    "lead_vocals": "lead_vocals",
    "backing_vocals": "backing_vocals",
    "drums": "drums",
    "bass": "bass",
    "guitar": "guitar",
    "acoustic_guitar": "acoustic_guitar",
    "electric_guitar": "electric_guitar",
    "piano": "piano",
    "synth": "synth",
    "strings": "strings",
    "other": "other",
    # aliases
    "vocals": "lead_vocals",
    "back_vocals": "backing_vocals",
    "synthesizer": "synth",
    "bowed_strings": "strings",
}

# Known stock models -> their source name list, for lightweight capability
# computation that does not require loading torch / the checkpoint.
KNOWN_MODEL_SOURCES: dict[str, list[str]] = {
    "htdemucs": ["drums", "bass", "other", "vocals"],
    "htdemucs_ft": ["drums", "bass", "other", "vocals"],
    "htdemucs_6s": ["drums", "bass", "other", "vocals", "guitar", "piano"],
    "hdemucs_mmi": ["drums", "bass", "other", "vocals"],
    "mdx": ["drums", "bass", "other", "vocals"],
    "mdx_extra": ["drums", "bass", "other", "vocals"],
}


def canonical_from_sources(source_names: list[str]) -> dict[str, str]:
    """Return {canonical_stem_id: model_source_name} for mappable sources."""
    out: dict[str, str] = {}
    for src in source_names:
        canon = SOURCE_TO_CANONICAL.get(src)
        if canon and canon not in out:
            out[canon] = src
    return out


def known_sources_for(model_name: str) -> list[str]:
    """Best-effort source list for a model name (defaults to the 6-stem set)."""
    return KNOWN_MODEL_SOURCES.get(model_name, KNOWN_MODEL_SOURCES["htdemucs_6s"])
