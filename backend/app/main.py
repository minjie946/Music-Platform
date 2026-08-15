"""FastAPI application entrypoint."""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .models import StemCapability
from .routes import (
    engine,
    generation,
    jobs,
    logs,
    settings as settings_routes,
    stems,
    svc,
    edit,
)
from .stems import STEMS

app = FastAPI(title="音乐分轨 API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(jobs.router)
app.include_router(stems.router)
app.include_router(engine.router)
app.include_router(settings_routes.router)
app.include_router(generation.router)
app.include_router(svc.router)
app.include_router(logs.router)
app.include_router(edit.router)


@app.on_event("startup")
def _startup() -> None:
    settings.ensure_dirs()
    from . import store

    if not store.ping():
        print(
            "\n[警告] 无法连接 Redis (%s)。\n"
            "        分轨任务需要 Redis + Celery worker。请改用一键启动:\n"
            "          ./start.sh        (项目根目录)\n"
            "        或  python run_local.py  (backend 目录)\n"
            "        单独运行 uvicorn 时上传会返回 503。\n" % settings.redis_url
        )


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/hardware")
def hardware_info() -> dict:
    from . import hardware

    return hardware.detect_dict()


@app.get("/api/stems", response_model=list[StemCapability])
def list_stems() -> list[StemCapability]:
    """All canonical stems (without engine-specific support flags)."""
    return [
        StemCapability(id=s.id, label_zh=s.label_zh, label_en=s.label_en, supported=True)
        for s in STEMS
    ]
