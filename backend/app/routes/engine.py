"""Engine capability endpoint."""
from __future__ import annotations

from fastapi import APIRouter

from ..engines.factory import capabilities_for
from ..models import EngineCapabilities, StemCapability
from ..stems import STEMS

router = APIRouter(prefix="/api/engine", tags=["engine"])

_UNSUPPORTED_NOTE = "当前引擎不支持，请在设置中配置 LALAL.AI"


@router.get("/capabilities", response_model=EngineCapabilities)
def get_capabilities(engine: str | None = None) -> EngineCapabilities:
    effective, supported = capabilities_for(engine)
    stems = [
        StemCapability(
            id=s.id,
            label_zh=s.label_zh,
            label_en=s.label_en,
            supported=s.id in supported,
            note="" if s.id in supported else _UNSUPPORTED_NOTE,
        )
        for s in STEMS
    ]
    return EngineCapabilities(engine=effective, stems=stems)
