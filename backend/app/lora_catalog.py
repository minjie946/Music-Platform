"""Curated catalog of music-generation LoRA adapters for ACE-Step 1.5.

Each entry points at a HuggingFace repo that hosts a PEFT LoRA adapter
(``adapter_config.json`` + ``adapter_model.safetensors``). We deliberately list
only standard PEFT-layout repos so the ACE-Step sidecar's ``load_lora`` can
consume them directly. LoHA/LyCORIS repos with bespoke layouts are excluded to
avoid load-time crashes.

The catalog is metadata only: adapters are NOT bundled with the app and are
downloaded on demand into the user's LoRA directory.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class LoraPreset:
    id: str                    # stable local slug (also the on-disk folder name)
    name: str                  # human-facing label (zh)
    repo: str                  # HuggingFace repo id
    category: str              # "instrumental" | "pop"
    # DiT base families this LoRA is compatible with. Matched against the loaded
    # DiT model name via substring (e.g. "turbo", "base", "sft", "xl").
    base_families: tuple[str, ...]
    subfolder: str = ""        # repo subfolder holding the adapter files ("" = root)
    description: str = ""


# Ordered by category then rough quality/recognizability. Only ACE-Step *1.5*
# adapters with a standard PEFT layout are included.
LORA_PRESETS: list[LoraPreset] = [
    # ---- 纯音乐 / 器乐 ----
    LoraPreset(
        id="acoustic-guitar-merge",
        name="原声吉他（器乐）",
        repo="DisturbingTheField/ACE-Step-v1.5-acoustic-guitar-and-a-merge-LoRA",
        category="instrumental",
        base_families=("base", "turbo"),
        description="原声吉他为主的器乐风格。",
    ),
    LoraPreset(
        id="ambient-dream",
        name="氛围梦境（Ambient）",
        repo="DisturbingTheField/ACE-Step-v1.5-ambient_dream1-LoRA",
        category="instrumental",
        base_families=("turbo",),
        description="空灵氛围 / ambient 器乐。",
    ),
    LoraPreset(
        id="symphonic-metal",
        name="交响金属",
        repo="6san/symphonic_metal_lora_for_ace-step_v15",
        category="instrumental",
        base_families=("sft",),
        description="交响金属编曲，器乐层次丰富。",
    ),
    LoraPreset(
        id="rain-techno",
        name="雨声 Techno（器乐）",
        repo="tarn59/ACE-STEP-1.5v-rain-techno-lora",
        category="instrumental",
        base_families=("base", "turbo", "sft", "xl"),
        description="器乐 techno。",
    ),
    # ---- 流行 / 电子舞曲 ----
    LoraPreset(
        id="kawaii-future-bass",
        name="Kawaii Future Bass（电子流行）",
        repo="NoyzeAI/ACE-Step-v1.5-Kawaii_Future_Bass-LoRA",
        category="pop",
        base_families=("base", "turbo", "sft", "xl"),
        description="可爱系未来贝斯 / 电子流行。",
    ),
    LoraPreset(
        id="super-eurobeats",
        name="Super Eurobeat（高能电子流行）",
        repo="tarn59/super_eurobeats_ACE_STEP-1.5-lora",
        category="pop",
        base_families=("base", "turbo", "sft", "xl"),
        description="高能 Eurobeat 电子流行。",
    ),
    LoraPreset(
        id="naija-legacy-rhythms",
        name="Naija 律动（Afrobeats 流行）",
        repo="David-A-Amoo/ACE-Step-1.5-Naija-Legacy-Rhythms-LoRA-v1",
        category="pop",
        base_families=("base", "sft"),
        description="尼日利亚 Afrobeats 流行节奏。",
    ),
    # ---- 官方 ----
    LoraPreset(
        id="official-cny",
        name="新春风（官方）",
        repo="ACE-Step/ACE-Step-v1.5-chinese-new-year-LoRA",
        category="instrumental",
        base_families=("base", "turbo", "sft", "xl"),
        description="官方出品，中国新年节庆风。",
    ),
]

CATEGORY_LABELS = {
    "instrumental": "纯音乐 / 器乐",
    "pop": "流行 / 电子",
}


def get_preset(preset_id: str) -> LoraPreset | None:
    for p in LORA_PRESETS:
        if p.id == preset_id:
            return p
    return None


def base_matches(preset: LoraPreset, dit_model: str | None) -> bool:
    """Return whether ``preset`` is compatible with the given DiT model name."""
    if not dit_model:
        return True
    name = dit_model.lower()
    return any(fam in name for fam in preset.base_families)
