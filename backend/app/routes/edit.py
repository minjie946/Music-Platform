"""Music editor endpoints (multi-track mix + pitch/tempo).

Mirrors the generation job flow: create -> status -> SSE progress -> download.
The heavy mixdown runs in the Celery worker via ``app.tasks.run_edit``.
"""
from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sse_starlette.sse import EventSourceResponse

from .. import store
from ..config import effective_edit_dir, ensure_runtime_dirs
from ..models import EditRequest, JobState, JobStatus, MelodyRequest, MelodyResult
from ._uploads import save_upload

router = APIRouter(prefix="/api/edit", tags=["edit"])

_MEDIA = {".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac"}


@router.post("/melody", response_model=MelodyResult)
def generate_melody_route(req: MelodyRequest) -> MelodyResult:
    """本地生成一条旋律线（可选分析某条伴奏轨的 key/bpm）。同步返回 MIDI 音符。"""
    from ..melody import generate_melody

    src_path = None
    if req.backing is not None:
        try:
            from ..tasks import _edit_source_path

            src_path = _edit_source_path(req.backing, effective_edit_dir())
        except Exception:  # noqa: BLE001
            src_path = None

    duration = float(req.duration_sec) if req.duration_sec and req.duration_sec > 0 else 16.0
    try:
        result = generate_melody(
            str(src_path) if src_path else None,
            duration_sec=duration,
            key_name=req.key_name,
            bpm=req.bpm,
            seed=req.seed,
            syllables=req.syllables,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"旋律生成失败：{exc}") from exc
    return MelodyResult(**result)


@router.post("", response_model=JobStatus)
def create_edit(req: EditRequest) -> JobStatus:
    if not req.tracks:
        raise HTTPException(status_code=400, detail="请至少选择一条音轨")
    if not any(not t.mute for t in req.tracks):
        raise HTTPException(status_code=400, detail="所有音轨均已静音，无法混音")
    try:
        ensure_runtime_dirs(("edit_output_dir",))
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not store.ping():
        raise HTTPException(
            status_code=503,
            detail="任务队列未连接：请重启应用；浏览器开发模式请运行 ./start.sh（或 python run_local.py）。",
        )

    job_id = uuid.uuid4().hex
    edit_dir = effective_edit_dir() / job_id
    edit_dir.mkdir(parents=True, exist_ok=True)
    (edit_dir / "request.json").write_text(req.model_dump_json(), "utf-8")

    title = (req.title or "").strip() or "混音"
    job = store.create_gen_job(job_id, title[:80], engine="editor")
    job.kind = "edit"
    store._save(job)

    from ..celery_app import celery_app

    celery_app.send_task("app.tasks.run_edit", args=[job_id])
    return job


@router.post("/upload")
async def upload_edit_track(file: UploadFile = File(...)) -> dict:
    """Stage an external audio file to add as an extra track ('add instrument')."""
    try:
        ensure_runtime_dirs(("edit_output_dir",))
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    staging = effective_edit_dir() / "_staging"
    staging.mkdir(parents=True, exist_ok=True)
    name = Path(file.filename or "audio").name or "audio"
    stored = f"{uuid.uuid4().hex}_{name}"
    await save_upload(file, staging / stored)
    return {"upload_name": stored, "label": name}


@router.get("/{job_id}", response_model=JobStatus)
def get_edit(job_id: str) -> JobStatus:
    job = store.get_job(job_id)
    if job is None:
        job = _edit_history_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在或已过期")
    return job


@router.get("/{job_id}/events")
async def edit_events(job_id: str):
    if store.get_job(job_id) is None:
        raise HTTPException(status_code=404, detail="任务不存在或已过期")

    async def event_generator():
        last_signature: tuple | None = None
        while True:
            current = store.get_job(job_id)
            if current is None:
                yield {"event": "error", "data": "job not found"}
                return
            signature = (current.state, current.progress, current.stage, len(current.tracks))
            if signature != last_signature:
                last_signature = signature
                yield {"event": "status", "data": current.model_dump_json()}
            if current.state in (JobState.done, JobState.failed):
                return
            await asyncio.sleep(0.5)

    return EventSourceResponse(event_generator())


@router.get("/{job_id}/result")
def get_result(job_id: str, download: bool = False):
    job = store.get_job(job_id) or _edit_history_job(job_id)
    if job is None or not job.tracks:
        raise HTTPException(status_code=404, detail="任务不存在或已过期")
    filename = job.tracks[0].filename
    fpath = _edit_file_path(job_id, filename)
    if fpath is None:
        raise HTTPException(status_code=404, detail="导出文件已被清理")
    media_type = _MEDIA.get(fpath.suffix.lower(), "application/octet-stream")
    return FileResponse(fpath, media_type=media_type, filename=filename if download else None)


def _edit_file_path(job_id: str, filename: str) -> Path | None:
    """Resolve an exported edit file, guarding against path traversal."""
    if not job_id or "/" in job_id or "\\" in job_id:
        return None
    name = (filename or "").strip()
    if not name or "/" in name or "\\" in name:
        return None
    base = (effective_edit_dir() / job_id).resolve()
    if base.parent != effective_edit_dir().resolve():
        return None
    p = (base / name).resolve()
    if p.parent == base and p.is_file():
        return p
    return None


def _edit_history_job(job_id: str) -> JobStatus | None:
    """Load a finished edit job from its durable job.json."""
    if not job_id or "/" in job_id or "\\" in job_id:
        return None
    meta = effective_edit_dir() / job_id / "job.json"
    if not meta.is_file():
        return None
    try:
        return JobStatus.model_validate_json(meta.read_text("utf-8"))
    except Exception:
        return None
